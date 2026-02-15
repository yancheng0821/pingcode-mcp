import { apiClient } from '../client.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { metrics } from '../../utils/metrics.js';
import { splitTimeRange, isTimeRangeExceedsThreeMonths } from '../../utils/timeUtils.js';
import type { PingCodeWorkload, RawPingCodeWorkload, PaginatedResponse } from '../types.js';
import { sanitizeTitle, sanitizeName, sanitizeDescription } from '../../utils/sanitize.js';

/**
 * Global fetch budget for circuit breaker across tiered bulk fetches.
 */
export interface FetchBudget {
  totalRecordsFetched: number;
  totalPagesFetched: number;
  readonly maxRecords: number;
  readonly maxPages: number;
  exhausted: boolean;
}

export function createFetchBudget(
  maxRecords = config.bulkFetch.circuitBreakerMaxRecords,
  maxPages = config.bulkFetch.circuitBreakerMaxPages
): FetchBudget {
  return {
    totalRecordsFetched: 0,
    totalPagesFetched: 0,
    maxRecords,
    maxPages,
    exhausted: false,
  };
}

export interface ListWorkloadsParams {
  startAt: number;  // Unix timestamp (seconds)
  endAt: number;    // Unix timestamp (seconds)
  userId?: string;  // Optional: filter by reporter (server-side via report_by_id)
  projectId?: string;  // Optional: filter by project (server-side via pilot_id)
  // API 原生参数（仅 work_item 类型，其他类型由 Tool 层转换）
  principalType?: 'work_item';
  principalId?: string;
  pageSize?: number;
  signal?: AbortSignal;
  budget?: FetchBudget;
}

export interface WorkloadsResult {
  workloads: PingCodeWorkload[];
  totalCount: number;
  timeSliced: boolean;
  paginationTruncated: boolean;
  truncationReasons: string[];
}

/**
 * 将原始 API 响应转换为标准化格式
 */
function transformWorkload(raw: RawPingCodeWorkload): PingCodeWorkload {
  return {
    id: raw.id,
    // project 需要后续通过 work_item 关联获取
    project: undefined,
    work_item: raw.principal && raw.principal_type === 'work_item' ? {
      id: raw.principal.id,
      identifier: raw.principal.identifier,
      title: sanitizeTitle(raw.principal.title) ?? '',
      type: raw.principal.type,
    } : undefined,
    duration: raw.duration,
    description: sanitizeDescription(raw.description),
    report_at: raw.report_at,
    report_by: {
      id: raw.report_by.id,
      name: sanitizeName(raw.report_by.name) ?? '',
      display_name: sanitizeName(raw.report_by.display_name) ?? '',
    },
    type: raw.type?.name,
    created_at: raw.created_at,
  };
}

/**
 * 获取工时记录
 * GET /v1/workloads
 *
 * 支持服务端过滤：
 * - report_by_id: 按填报人过滤
 * - pilot_id + principal_type: 按项目过滤
 *
 * 自动处理：
 * - 时间分片（>3个月自动拆分）
 * - 分页拉取
 * - 去重（以 workload_id 为主键）
 */
export async function listWorkloads(params: ListWorkloadsParams): Promise<WorkloadsResult> {
  const { startAt, endAt, userId, projectId, principalType, principalId, pageSize = config.pagination.pageSize, signal, budget } = params;

  const needsSlicing = isTimeRangeExceedsThreeMonths(startAt, endAt);
  const timeChunks = needsSlicing ? splitTimeRange(startAt, endAt) : [[startAt, endAt]];

  // 记录分片指标
  metrics.recordTimeSlice(timeChunks.length);

  logger.info({
    userId,
    projectId,
    startAt,
    endAt,
    needsSlicing,
    chunksCount: timeChunks.length,
  }, 'Fetching workloads');

  const allWorkloads: PingCodeWorkload[] = [];
  const seenIds = new Set<string>();
  let paginationTruncated = false;
  let maxRecordsReached = false;
  const truncationReasons: string[] = [];
  const fetchStartTime = Date.now();

  // Process each time chunk
  for (const [chunkStart, chunkEnd] of timeChunks) {
    if (maxRecordsReached) break;

    let currentPage = 0;  // page_index starts from 0
    let hasMore = true;

    while (hasMore) {
      // Check signal before each page fetch
      if (signal?.aborted) {
        paginationTruncated = true;
        truncationReasons.push('signal_aborted');
        break;
      }

      // Circuit breaker: check shared budget
      if (budget?.exhausted) {
        paginationTruncated = true;
        truncationReasons.push('circuit_breaker');
        break;
      }

      // Soft elapsed-time check: gracefully truncate before MCP hard-abort
      if (Date.now() - fetchStartTime > config.pagination.maxFetchDurationMs) {
        logger.warn({
          elapsed: Date.now() - fetchStartTime,
          maxFetchDurationMs: config.pagination.maxFetchDurationMs,
          fetchedSoFar: allWorkloads.length,
        }, 'Fetch duration exceeded — returning partial results');
        paginationTruncated = true;
        truncationReasons.push('timeout');
        break;
      }

      try {
        // 构建请求参数
        const requestParams: Record<string, string | number | undefined> = {
          start_at: chunkStart,
          end_at: chunkEnd,
          page_size: pageSize,
          page_index: currentPage,
        };

        // 服务端过滤：按用户
        if (userId) {
          requestParams.report_by_id = userId;
        }

        // 服务端过滤：按项目（需要同时指定 principal_type）
        if (projectId) {
          requestParams.pilot_id = projectId;
          requestParams.principal_type = principalType || 'work_item';
        }

        // PRD 参数：principal_type + principal_id（按工作项/想法/用例查询）
        if (principalType && principalId) {
          requestParams.principal_type = principalType;
          requestParams.principal_id = principalId;
        }

        const response = await apiClient.request<PaginatedResponse<RawPingCodeWorkload>>(
          '/v1/workloads',
          {
            params: requestParams,
            signal,
          }
        );

        // 转换并去重
        for (const rawWorkload of response.values) {
          if (!seenIds.has(rawWorkload.id)) {
            seenIds.add(rawWorkload.id);
            allWorkloads.push(transformWorkload(rawWorkload));
          }
        }

        // Update shared budget counters
        if (budget) {
          budget.totalPagesFetched++;
          budget.totalRecordsFetched = allWorkloads.length;
          if (budget.totalRecordsFetched >= budget.maxRecords || budget.totalPagesFetched >= budget.maxPages) {
            budget.exhausted = true;
            paginationTruncated = true;
            truncationReasons.push('circuit_breaker');
            metrics.recordCircuitBreakerTriggered();
            break;
          }
        }

        // Check maxRecords hard cap
        if (allWorkloads.length >= config.pagination.maxRecords) {
          paginationTruncated = true;
          maxRecordsReached = true;
          truncationReasons.push('max_records');
          break;
        }

        // Calculate hasMore from pagination fields
        hasMore = (response.page_index + 1) * response.page_size < response.total;
        currentPage++;

        // Safety limit
        if (currentPage > config.pagination.maxPages) {
          logger.warn({
            currentPage,
            chunkStart,
            chunkEnd,
          }, 'Reached max pages limit for workloads');
          paginationTruncated = true;
          truncationReasons.push('max_pages');
          break;
        }
      } catch (error) {
        logger.error({
          error,
          chunkStart,
          chunkEnd,
          currentPage,
        }, 'Failed to fetch workloads chunk');

        // Continue with partial results
        paginationTruncated = true;
        truncationReasons.push('fetch_error');
        break;
      }
    }
  }

  logger.info({
    totalWorkloads: allWorkloads.length,
    timeSliced: needsSlicing,
    paginationTruncated,
  }, 'Workloads fetch completed');

  return {
    workloads: allWorkloads,
    totalCount: allWorkloads.length,
    timeSliced: needsSlicing,
    paginationTruncated,
    truncationReasons,
  };
}

/**
 * 获取用户的工时记录
 */
export async function listUserWorkloads(
  userId: string,
  startAt: number,
  endAt: number,
  signal?: AbortSignal
): Promise<WorkloadsResult> {
  return listWorkloads({
    startAt,
    endAt,
    userId,
    signal,
  });
}

/**
 * 获取项目的工时记录
 */
export async function listProjectWorkloads(
  projectId: string,
  startAt: number,
  endAt: number,
  signal?: AbortSignal
): Promise<WorkloadsResult> {
  return listWorkloads({
    startAt,
    endAt,
    projectId,
    signal,
  });
}

/**
 * Batched concurrent per-user fetch.
 *
 * Splits userIds into sequential batches of `batchSize`, runs
 * `concurrency` batches in parallel. Each individual user fetch
 * uses server-side `report_by_id` filtering — no unfiltered bulk
 * downloads.
 */
async function fetchBatchedPerUser(
  userIds: string[],
  startAt: number,
  endAt: number,
  batchSize: number,
  concurrency: number,
  budget: FetchBudget,
  opts: { projectId?: string; signal?: AbortSignal },
): Promise<Map<string, WorkloadsResult>> {
  const { projectId, signal } = opts;
  const results = new Map<string, WorkloadsResult>();

  for (let i = 0; i < userIds.length; i += batchSize * concurrency) {
    if (budget.exhausted || signal?.aborted) break;

    // Create concurrent batch groups
    const batchGroups: string[][] = [];
    for (let j = 0; j < concurrency; j++) {
      const start = i + j * batchSize;
      const end = Math.min(start + batchSize, userIds.length);
      if (start < userIds.length) {
        batchGroups.push(userIds.slice(start, end));
      }
    }

    // Process batch groups concurrently
    const groupResults = await Promise.all(
      batchGroups.map(async (group) => {
        const groupMap = new Map<string, WorkloadsResult>();
        for (const userId of group) {
          if (budget.exhausted || signal?.aborted) break;
          const result = await listWorkloads({ startAt, endAt, userId, projectId, signal, budget });
          groupMap.set(userId, result);
        }
        return groupMap;
      })
    );

    // Merge results
    for (const groupMap of groupResults) {
      for (const [userId, result] of groupMap) {
        results.set(userId, result);
      }
    }
  }

  return results;
}

/**
 * 批量获取多个用户的工时记录
 *
 * Three-tier strategy — all tiers use server-side report_by_id filtering
 * (no unfiltered bulk fetch):
 *
 * - Small  (≤ smallThreshold):  Sequential per-user
 * - Medium (≤ mediumThreshold): Batched concurrent (batchSize=10, concurrency=3)
 * - Large  (> mediumThreshold): Batched concurrent (batchSize=20, concurrency=5)
 *
 * All tiers share a FetchBudget for global circuit breaker protection.
 */
export async function listWorkloadsForUsers(
  userIds: string[],
  startAt: number,
  endAt: number,
  options?: { projectId?: string; signal?: AbortSignal }
): Promise<Map<string, WorkloadsResult>> {
  const { projectId, signal } = options || {};
  const results = new Map<string, WorkloadsResult>();
  const budget = createFetchBudget();
  const {
    smallThreshold, mediumThreshold,
    mediumBatchSize, mediumConcurrency,
    largeBatchSize, largeConcurrency,
  } = config.bulkFetch;

  let tierResults: Map<string, WorkloadsResult>;

  if (userIds.length <= smallThreshold) {
    // Small tier: sequential per-user, server-side filtering
    tierResults = new Map();
    for (const userId of userIds) {
      if (budget.exhausted || signal?.aborted) break;
      const result = await listWorkloads({ startAt, endAt, userId, projectId, signal, budget });
      tierResults.set(userId, result);
    }
  } else if (userIds.length <= mediumThreshold) {
    // Medium tier: batched concurrent per-user
    tierResults = await fetchBatchedPerUser(
      userIds, startAt, endAt,
      mediumBatchSize, mediumConcurrency,
      budget, { projectId, signal },
    );
  } else {
    // Large tier: batched concurrent per-user with larger batches & higher concurrency
    tierResults = await fetchBatchedPerUser(
      userIds, startAt, endAt,
      largeBatchSize, largeConcurrency,
      budget, { projectId, signal },
    );
  }

  // Copy tier results into final map
  for (const [userId, result] of tierResults) {
    results.set(userId, result);
  }

  // Fill missing users (budget exhausted before reaching them) with empty truncated results
  if (budget.exhausted) {
    for (const userId of userIds) {
      if (!results.has(userId)) {
        results.set(userId, {
          workloads: [],
          totalCount: 0,
          timeSliced: false,
          paginationTruncated: true,
          truncationReasons: ['circuit_breaker'],
        });
      }
    }
  }

  return results;
}
