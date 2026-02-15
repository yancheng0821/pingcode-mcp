import { z } from 'zod';
import { userService } from '../services/userService.js';
import { logger } from '../utils/logger.js';
import { createToolDefinition } from './schemaUtils.js';

// ============ 常量 ============

const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 100;

// ============ Schema 定义 ============

export const ListUsersInputSchema = z.object({
  keyword: z.string().optional(),
  // 新分页参数
  page_size: z.number().min(1).optional(),
  page_index: z.number().min(1).optional().default(1),
  // 兼容旧参数
  limit: z.number().optional(),
  // Internal: set by scopeEnforcer in user mode to restrict results to a single user
  _restrict_to_user_id: z.string().optional(),
});

export type ListUsersInput = z.infer<typeof ListUsersInputSchema>;

// ============ 输出类型 ============

export interface ListUsersOutput {
  users: Array<{
    id: string;
    name: string;
    display_name: string;
    email?: string;
    department?: string;
    job?: string;
  }>;
  total: number;
  page_index: number;
  page_size: number;
  has_more: boolean;
}

export interface ListUsersError {
  error: string;
  code: 'INTERNAL_ERROR';
}

export type ListUsersResult = ListUsersOutput | ListUsersError;

// ============ Tool 实现 ============

export async function listUsers(input: ListUsersInput, signal?: AbortSignal): Promise<ListUsersResult> {
  logger.info({ input }, 'list_users called');

  try {
    const allUsers = await userService.getAllUsers(signal);

    let filteredUsers = allUsers;

    // User-mode scope restriction: only return the authenticated user's record
    if (input._restrict_to_user_id) {
      filteredUsers = allUsers.filter(u => u.id === input._restrict_to_user_id);
    }

    // 按关键词过滤
    if (input.keyword) {
      const keyword = input.keyword.toLowerCase();
      filteredUsers = filteredUsers.filter(u =>
        u.name.toLowerCase().includes(keyword) ||
        u.display_name.toLowerCase().includes(keyword) ||
        (u.email && u.email.toLowerCase().includes(keyword))
      );
    }

    const total = filteredUsers.length;

    // 计算分页参数
    // 优先使用 page_size，其次使用 limit（兼容），否则使用默认值
    const pageSize = Math.min(
      input.page_size ?? input.limit ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE
    );
    const pageIndex = input.page_index ?? 1;

    // 计算分页偏移
    const offset = (pageIndex - 1) * pageSize;
    const pagedUsers = filteredUsers.slice(offset, offset + pageSize);
    const hasMore = offset + pagedUsers.length < total;

    return {
      users: pagedUsers.map(u => ({
        id: u.id,
        name: u.name,
        display_name: u.display_name,
        email: u.email,
        department: u.department,
        job: u.job,
      })),
      total,
      page_index: pageIndex,
      page_size: pageSize,
      has_more: hasMore,
    };
  } catch (error) {
    logger.error({ error, input }, 'list_users failed');
    return {
      error: `Internal error: ${(error as Error).message}`,
      code: 'INTERNAL_ERROR',
    };
  }
}

// ============ MCP Tool 定义 ============

export const listUsersToolDefinition = {
  name: 'list_users',
  ...createToolDefinition(
    `获取企业成员列表。

支持：
- 按关键词搜索（姓名、用户名、邮箱）
- 分页查询

返回：
- users: 用户列表
- total: 匹配的总数
- page_index/page_size: 分页信息
- has_more: 是否有更多数据`,
    ListUsersInputSchema,
  ),
};
