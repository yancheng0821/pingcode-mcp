import { apiClient } from '../client.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { metrics } from '../../utils/metrics.js';
import { splitTimeRange, isTimeRangeExceedsThreeMonths } from '../../utils/timeUtils.js';
import type { PingCodeWorkload, PaginatedResponse } from '../types.js';

export interface ListWorkloadsParams {
  startAt: number;  // Unix timestamp (seconds)
  endAt: number;    // Unix timestamp (seconds)
  userId?: string;  // Optional: filter by reporter (client-side)
  projectId?: string;  // Optional: filter by project (client-side)
  pageSize?: number;
}

export interface WorkloadsResult {
  workloads: PingCodeWorkload[];
  totalCount: number;
  timeSliced: boolean;
  paginationTruncated: boolean;
}

/**
 * 获取工时记录
 * GET /v1/project/workloads
 *
 * 自动处理：
 * - 时间分片（>3个月自动拆分）
 * - 分页拉取
 * - 去重（以 workload_id 为主键）
 */
export async function listWorkloads(params: ListWorkloadsParams): Promise<WorkloadsResult> {
  const { startAt, endAt, userId, projectId, pageSize = config.pagination.pageSize } = params;

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
        const response = await apiClient.request<PaginatedResponse<PingCodeWorkload>>(
          '/v1/project/workloads',
          {
            params: {
              start_at: chunkStart,
              end_at: chunkEnd,
              page_size: pageSize,
              page_index: currentPage,
            },
          }
        );

        // Deduplicate by workload id
        for (const workload of response.values) {
          if (!seenIds.has(workload.id)) {
            seenIds.add(workload.id);
            allWorkloads.push(workload);
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

  // Client-side filtering
  let filteredWorkloads = allWorkloads;

  if (userId) {
    filteredWorkloads = filteredWorkloads.filter(w => w.report_by.id === userId);
  }

  if (projectId) {
    filteredWorkloads = filteredWorkloads.filter(w => w.project.id === projectId);
  }

  logger.info({
    totalWorkloads: allWorkloads.length,
    filteredWorkloads: filteredWorkloads.length,
    timeSliced: needsSlicing,
    paginationTruncated,
  }, 'Workloads fetch completed');

  return {
    workloads: filteredWorkloads,
    totalCount: filteredWorkloads.length,
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
 * 优化：只拉取一次全部数据，然后按用户分组
 */
export async function listWorkloadsForUsers(
  userIds: string[],
  startAt: number,
  endAt: number
): Promise<Map<string, WorkloadsResult>> {
  // 拉取时间范围内的所有工时记录
  const allResult = await listWorkloads({ startAt, endAt });

  const results = new Map<string, WorkloadsResult>();

  // 按用户分组
  for (const userId of userIds) {
    const userWorkloads = allResult.workloads.filter(w => w.report_by.id === userId);
    results.set(userId, {
      workloads: userWorkloads,
      totalCount: userWorkloads.length,
      timeSliced: allResult.timeSliced,
      paginationTruncated: allResult.paginationTruncated,
    });
  }

  return results;
}
