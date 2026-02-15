import { apiClient } from '../client.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { metrics } from '../../utils/metrics.js';
import { splitTimeRange, isTimeRangeExceedsThreeMonths } from '../../utils/timeUtils.js';
import type { PingCodeWorkload, RawPingCodeWorkload, PaginatedResponse } from '../types.js';

export interface ListWorkloadsParams {
  startAt: number;  // Unix timestamp (seconds)
  endAt: number;    // Unix timestamp (seconds)
  userId?: string;  // Optional: filter by reporter (server-side via report_by_id)
  projectId?: string;  // Optional: filter by project (server-side via pilot_id)
  // API 原生参数（仅 work_item 类型，其他类型由 Tool 层转换）
  principalType?: 'work_item';
  principalId?: string;
  pageSize?: number;
}

export interface WorkloadsResult {
  workloads: PingCodeWorkload[];
  totalCount: number;
  timeSliced: boolean;
  paginationTruncated: boolean;
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
      title: raw.principal.title,
      type: raw.principal.type,
    } : undefined,
    duration: raw.duration,
    description: raw.description,
    report_at: raw.report_at,
    report_by: {
      id: raw.report_by.id,
      name: raw.report_by.name,
      display_name: raw.report_by.display_name,
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
  const { startAt, endAt, userId, projectId, principalType, principalId, pageSize = config.pagination.pageSize } = params;

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

  // Process each time chunk
  for (const [chunkStart, chunkEnd] of timeChunks) {
    let currentPage = 0;  // page_index starts from 0
    let hasMore = true;

    while (hasMore) {
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
          }
        );

        // 转换并去重
        for (const rawWorkload of response.values) {
          if (!seenIds.has(rawWorkload.id)) {
            seenIds.add(rawWorkload.id);
            allWorkloads.push(transformWorkload(rawWorkload));
          }
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
    startAt,
    endAt,
    userId,
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
    startAt,
    endAt,
    projectId,
  });
}

/**
 * 批量获取多个用户的工时记录
 *
 * 策略选择：
 * - 用户数 ≤ PER_USER_THRESHOLD：逐用户调用服务端 report_by_id 过滤（减少下载量）
 * - 用户数 > PER_USER_THRESHOLD：一次拉取全部数据，本地按用户分组（减少 API 调用）
 */
const PER_USER_THRESHOLD = 5;

export async function listWorkloadsForUsers(
  userIds: string[],
  startAt: number,
  endAt: number,
  options?: { projectId?: string }
): Promise<Map<string, WorkloadsResult>> {
  const { projectId } = options || {};
  const results = new Map<string, WorkloadsResult>();

  if (userIds.length <= PER_USER_THRESHOLD) {
    // 少量用户：逐用户服务端过滤，减少传输量
    for (const userId of userIds) {
      const result = await listWorkloads({ startAt, endAt, userId, projectId });
      results.set(userId, result);
    }
  } else {
    // 大量用户：拉取全量，本地分组（避免 N 次 API 调用）
    const allResult = await listWorkloads({ startAt, endAt, projectId });

    for (const userId of userIds) {
      const userWorkloads = allResult.workloads.filter(w => w.report_by.id === userId);
      results.set(userId, {
        workloads: userWorkloads,
        totalCount: userWorkloads.length,
        timeSliced: allResult.timeSliced,
        paginationTruncated: allResult.paginationTruncated,
      });
    }
  }

  return results;
}
