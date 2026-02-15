import { apiClient } from '../client.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { cache, CacheKeys } from '../../cache/index.js';
import type { PingCodeUser, PaginatedResponse } from '../types.js';

export interface ListUsersParams {
  keyword?: string;
  pageSize?: number;
  pageIndex?: number;
}

export interface UserMatch {
  user: PingCodeUser;
  matchType: 'exact' | 'contains' | 'fuzzy';
}

/**
 * 获取企业成员列表（带缓存）
 * GET /v1/directory/users
 *
 * 缓存策略：全量用户列表缓存 TTL = config.cache.ttlUsers (默认 1h)。
 * 关键词过滤在缓存之后本地完成。
 */
export async function listUsers(params: ListUsersParams = {}, signal?: AbortSignal): Promise<PingCodeUser[]> {
  const { keyword, pageSize = 100, pageIndex = 0 } = params;

  // 尝试从缓存读取全量用户列表
  const cacheKey = CacheKeys.usersList();
  let allUsers = await cache.get<PingCodeUser[]>(cacheKey);

  if (!allUsers) {
    // 缓存未命中，从 API 拉取全量
    allUsers = [];
    let currentPage = pageIndex;
    let hasMore = true;

    while (hasMore) {
      const response = await apiClient.request<PaginatedResponse<PingCodeUser>>(
        '/v1/directory/users',
        {
          params: {
            page_size: pageSize,
            page_index: currentPage,
          },
          signal,
        }
      );

      allUsers.push(...response.values);
      // Calculate hasMore from pagination fields
      hasMore = (response.page_index + 1) * response.page_size < response.total;
      currentPage++;

      // Safety limit
      if (currentPage > config.pagination.maxPages) {
        logger.warn({ currentPage }, 'Reached max pages limit for users');
        break;
      }
    }

    // 写入缓存
    await cache.set(cacheKey, allUsers, config.cache.ttlUsers);
    logger.debug({ count: allUsers.length, ttl: config.cache.ttlUsers }, 'User list cached');
  }

  // Filter by keyword if provided (client-side filtering)
  if (keyword) {
    const lowerKeyword = keyword.toLowerCase();
    return allUsers.filter(user =>
      user.name?.toLowerCase().includes(lowerKeyword) ||
      user.display_name?.toLowerCase().includes(lowerKeyword) ||
      user.email?.toLowerCase().includes(lowerKeyword)
    );
  }

  return allUsers;
}

/**
 * 根据 ID 获取用户
 */
export async function getUserById(userId: string, signal?: AbortSignal): Promise<PingCodeUser | null> {
  // 不缓存，直接从列表查找
  const users = await listUsers({}, signal);
  return users.find(u => u.id === userId) || null;
}

/**
 * 根据姓名匹配用户
 * 支持 strict / best / prompt 三种策略
 */
export async function matchUserByName(
  name: string,
  strategy: 'strict' | 'best' | 'prompt' = config.nameMatchStrategy
): Promise<{
  matched: PingCodeUser | null;
  candidates: UserMatch[];
  ambiguous: boolean;
}> {
  const users = await listUsers();
  const lowerName = name.toLowerCase().trim();

  const candidates: UserMatch[] = [];

  for (const user of users) {
    const displayNameLower = user.display_name?.toLowerCase() || '';
    const nameLower = user.name?.toLowerCase() || '';

    // Exact match
    if (displayNameLower === lowerName || nameLower === lowerName) {
      candidates.push({ user, matchType: 'exact' });
    }
    // Contains match
    else if (displayNameLower.includes(lowerName) || nameLower.includes(lowerName)) {
      candidates.push({ user, matchType: 'contains' });
    }
    // Reverse contains (name contains input)
    else if (lowerName.includes(displayNameLower) || lowerName.includes(nameLower)) {
      candidates.push({ user, matchType: 'fuzzy' });
    }
  }

  // Sort: exact > contains > fuzzy
  candidates.sort((a, b) => {
    const order = { exact: 0, contains: 1, fuzzy: 2 };
    return order[a.matchType] - order[b.matchType];
  });

  logger.debug({
    name,
    strategy,
    candidatesCount: candidates.length,
    exactCount: candidates.filter(c => c.matchType === 'exact').length,
  }, 'User name matching');

  // Strategy handling
  if (strategy === 'strict') {
    // Only exact match, and must be unique
    const exactMatches = candidates.filter(c => c.matchType === 'exact');
    if (exactMatches.length === 1) {
      return { matched: exactMatches[0].user, candidates: exactMatches, ambiguous: false };
    }
    return { matched: null, candidates, ambiguous: candidates.length > 0 };
  }

  if (strategy === 'best') {
    // Exact match first
    const exactMatches = candidates.filter(c => c.matchType === 'exact');
    if (exactMatches.length === 1) {
      return { matched: exactMatches[0].user, candidates: exactMatches, ambiguous: false };
    }
    if (exactMatches.length > 1) {
      return { matched: null, candidates: exactMatches, ambiguous: true };
    }

    // Contains match if only one
    const containsMatches = candidates.filter(c => c.matchType === 'contains');
    if (containsMatches.length === 1) {
      return { matched: containsMatches[0].user, candidates: containsMatches, ambiguous: false };
    }
    if (containsMatches.length > 1) {
      return { matched: null, candidates: containsMatches, ambiguous: true };
    }

    // No good match
    return { matched: null, candidates, ambiguous: candidates.length > 0 };
  }

  // strategy === 'prompt': always return candidates for confirmation
  return { matched: null, candidates, ambiguous: true };
}

/**
 * 批量获取用户详情
 */
export async function getUsersByIds(userIds: string[], signal?: AbortSignal): Promise<Map<string, PingCodeUser>> {
  if (userIds.length === 0) return new Map();

  const uniqueIds = new Set(userIds);
  const users = await listUsers({}, signal);
  const result = new Map<string, PingCodeUser>();

  for (const user of users) {
    if (uniqueIds.has(user.id)) {
      result.set(user.id, user);
    }
  }

  return result;
}
