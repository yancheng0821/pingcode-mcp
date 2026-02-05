import { apiClient } from '../client.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { metrics } from '../../utils/metrics.js';
import { splitTimeRange, isTimeRangeExceedsThreeMonths } from '../../utils/timeUtils.js';
import { generateMockWorkloads } from '../../mock/data.js';
import type { PingCodeWorkload, PaginatedResponse } from '../types.js';

export type PrincipalType = 'user' | 'project' | 'work_item';

export interface ListWorkloadsParams {
  principalType: PrincipalType;
  principalId: string;
  startAt: number;  // Unix timestamp (seconds)
  endAt: number;    // Unix timestamp (seconds)
  reportById?: string;  // Optional: filter by reporter
  pageSize?: number;
  pageIndex?: number;
}

export interface WorkloadsResult {
  workloads: PingCodeWorkload[];
  totalCount: number;
  timeSliced: boolean;
  paginationTruncated: boolean;
}

/**
 * 获取工时记录
 * GET /v1/workloads
 *
 * 自动处理：
 * - 时间分片（>3个月自动拆分）
 * - 分页拉取
 * - 去重（以 workload_id 为主键）
 */
export async function listWorkloads(params: ListWorkloadsParams): Promise<WorkloadsResult> {
  const {
    principalType,
    principalId,
    startAt,
    endAt,
  } = params;

  // Mock 模式
  if (config.mockMode) {
    logger.debug({ principalType, principalId }, 'Using mock data for listWorkloads');
    const needsSlicing = isTimeRangeExceedsThreeMonths(startAt, endAt);

    if (principalType === 'user') {
      const workloads = generateMockWorkloads(principalId, startAt, endAt);
      return {
        workloads,
        totalCount: workloads.length,
        timeSliced: needsSlicing,
        paginationTruncated: false,
      };
    }

    // 其他类型暂时返回空
    return {
      workloads: [],
      totalCount: 0,
      timeSliced: needsSlicing,
      paginationTruncated: false,
    };
  }

  const { reportById, pageSize = config.pagination.pageSize } = params;

  const needsSlicing = isTimeRangeExceedsThreeMonths(startAt, endAt);
  const timeChunks = needsSlicing ? splitTimeRange(startAt, endAt) : [[startAt, endAt]];

  // 记录分片指标
  metrics.recordTimeSlice(timeChunks.length);

  logger.info({
    principalType,
    principalId,
    startAt,
    endAt,
    needsSlicing,
    chunksCount: timeChunks.length,
  }, 'Fetching workloads');

  const allWorkloads: PingCodeWorkload[] = [];
  const seenIds = new Set<string>();
  let paginationTruncated = false;

  // Process each time chunk
  for (const [chunkStart, chunkEnd] of timeChunks) {
    let currentPage = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await apiClient.request<PaginatedResponse<PingCodeWorkload>>(
          '/v1/workloads',
          {
            params: {
              principal_type: principalType,
              principal_id: principalId,
              start_at: chunkStart,
              end_at: chunkEnd,
              report_by_id: reportById,
              page_size: pageSize,
              page_index: currentPage,
            },
          }
        );

        // Deduplicate by workload id
        for (const workload of response.data) {
          if (!seenIds.has(workload.id)) {
            seenIds.add(workload.id);
            allWorkloads.push(workload);
          }
        }

        hasMore = response.has_more;
        currentPage++;

        // Safety limit
        if (currentPage > config.pagination.maxPages) {
          logger.warn({
            currentPage,
            chunkStart,
            chunkEnd,
          }, 'Reached max pages limit for workloads');
          paginationTruncated = true;
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
  };
}

/**
 * 获取用户的工时记录
 */
export async function listUserWorkloads(
  userId: string,
  startAt: number,
  endAt: number
): Promise<WorkloadsResult> {
  return listWorkloads({
    principalType: 'user',
    principalId: userId,
    startAt,
    endAt,
  });
}

/**
 * 获取项目的工时记录
 */
export async function listProjectWorkloads(
  projectId: string,
  startAt: number,
  endAt: number
): Promise<WorkloadsResult> {
  return listWorkloads({
    principalType: 'project',
    principalId: projectId,
    startAt,
    endAt,
  });
}

/**
 * 批量获取多个用户的工时记录
 * 并行请求以提高效率
 */
export async function listWorkloadsForUsers(
  userIds: string[],
  startAt: number,
  endAt: number,
  concurrency: number = 5
): Promise<Map<string, WorkloadsResult>> {
  const results = new Map<string, WorkloadsResult>();

  // Process in batches for concurrency control
  for (let i = 0; i < userIds.length; i += concurrency) {
    const batch = userIds.slice(i, i + concurrency);

    const batchResults = await Promise.all(
      batch.map(async (userId) => {
        try {
          const result = await listUserWorkloads(userId, startAt, endAt);
          return { userId, result };
        } catch (error) {
          logger.error({ userId, error }, 'Failed to fetch user workloads');
          return {
            userId,
            result: {
              workloads: [],
              totalCount: 0,
              timeSliced: false,
              paginationTruncated: true,
            },
          };
        }
      })
    );

    for (const { userId, result } of batchResults) {
      results.set(userId, result);
    }
  }

  return results;
}
