import { apiClient, PingCodeApiError } from '../client.js';
import { cache, CacheKeys } from '../../cache/index.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { getMockWorkItem } from '../../mock/data.js';
import type { PingCodeWorkItem } from '../types.js';

/**
 * 获取工作项详情
 * GET /v1/project/work_items/{project_work_item_id}
 */
export async function getWorkItem(workItemId: string): Promise<PingCodeWorkItem | null> {
  // Mock 模式
  if (config.mockMode) {
    logger.debug({ workItemId }, 'Using mock data for getWorkItem');
    return getMockWorkItem(workItemId) || null;
  }

  // Try cache first
  const cached = await cache.get<PingCodeWorkItem>(CacheKeys.workItem(workItemId));
  if (cached) {
    return cached;
  }

  try {
    const workItem = await apiClient.request<PingCodeWorkItem>(
      `/v1/project/work_items/${workItemId}`
    );

    // Cache the result
    await cache.set(
      CacheKeys.workItem(workItemId),
      workItem,
      config.cache.ttlWorkItems
    );

    return workItem;
  } catch (error) {
    if (error instanceof PingCodeApiError && error.status === 404) {
      logger.debug({ workItemId }, 'Work item not found');
      return null;
    }
    throw error;
  }
}

/**
 * 批量获取工作项详情
 * 自动处理缓存和并发控制
 */
export async function getWorkItemsBatch(
  workItemIds: string[],
  concurrency: number = 10
): Promise<{
  items: Map<string, PingCodeWorkItem>;
  missingCount: number;
}> {
  if (workItemIds.length === 0) {
    return { items: new Map(), missingCount: 0 };
  }

  const uniqueIds = [...new Set(workItemIds)];
  const result = new Map<string, PingCodeWorkItem>();
  let missingCount = 0;

  // Mock 模式
  if (config.mockMode) {
    logger.debug({ count: uniqueIds.length }, 'Using mock data for getWorkItemsBatch');
    for (const id of uniqueIds) {
      const item = getMockWorkItem(id);
      if (item) {
        result.set(id, item);
      } else {
        missingCount++;
      }
    }
    return { items: result, missingCount };
  }

  // Try cache first
  const cacheKeys = uniqueIds.map(id => CacheKeys.workItem(id));
  const cached = await cache.mget<PingCodeWorkItem>(cacheKeys);

  const missingIds: string[] = [];
  uniqueIds.forEach((id, index) => {
    const cachedItem = cached.get(cacheKeys[index]);
    if (cachedItem) {
      result.set(id, cachedItem);
    } else {
      missingIds.push(id);
    }
  });

  logger.debug({
    totalIds: uniqueIds.length,
    cacheHits: result.size,
    cacheMisses: missingIds.length,
  }, 'Work items batch cache check');

  // Fetch missing items with concurrency control
  if (missingIds.length > 0) {
    const toCache: Array<{ key: string; value: PingCodeWorkItem; ttl: number }> = [];

    for (let i = 0; i < missingIds.length; i += concurrency) {
      const batch = missingIds.slice(i, i + concurrency);

      const batchResults = await Promise.all(
        batch.map(async (id) => {
          try {
            const item = await fetchWorkItemDirect(id);
            return { id, item };
          } catch (error) {
            logger.error({ workItemId: id, error }, 'Failed to fetch work item');
            return { id, item: null };
          }
        })
      );

      for (const { id, item } of batchResults) {
        if (item) {
          result.set(id, item);
          toCache.push({
            key: CacheKeys.workItem(id),
            value: item,
            ttl: config.cache.ttlWorkItems,
          });
        } else {
          missingCount++;
        }
      }
    }

    // Batch cache write
    if (toCache.length > 0) {
      await cache.mset(toCache);
    }
  }

  logger.info({
    requested: uniqueIds.length,
    found: result.size,
    missing: missingCount,
  }, 'Work items batch fetch completed');

  return { items: result, missingCount };
}

/**
 * 直接从 API 获取工作项（不走缓存）
 */
async function fetchWorkItemDirect(workItemId: string): Promise<PingCodeWorkItem | null> {
  try {
    return await apiClient.request<PingCodeWorkItem>(
      `/v1/project/work_items/${workItemId}`
    );
  } catch (error) {
    if (error instanceof PingCodeApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * 从工时记录中提取并获取所有关联的工作项
 */
export async function getWorkItemsFromWorkloads(
  workloads: Array<{ work_item_id?: string }>
): Promise<{
  items: Map<string, PingCodeWorkItem>;
  missingCount: number;
}> {
  const workItemIds = workloads
    .map(w => w.work_item_id)
    .filter((id): id is string => !!id);

  return getWorkItemsBatch(workItemIds);
}
