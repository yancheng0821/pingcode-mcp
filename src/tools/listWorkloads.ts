import { z } from 'zod';
import { listWorkloads as apiListWorkloads, type PrincipalType } from '../api/endpoints/workloads.js';
import { userService } from '../services/userService.js';
import { workItemService } from '../services/workItemService.js';
import { parseTimeRange } from '../utils/timeUtils.js';
import { formatTimestamp } from '../utils/timeUtils.js';
import { logger } from '../utils/logger.js';

// ============ 常量 ============

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

// ============ Schema 定义 ============

export const ListWorkloadsInputSchema = z.object({
  // 新参数：principal_type 和 principal_id
  principal_type: z.enum(['user', 'project', 'work_item']).optional(),
  principal_id: z.string().optional(),
  // 兼容旧参数：user 字段
  user: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
  }).optional(),
  time_range: z.object({
    start: z.string(),
    end: z.string(),
  }),
  // API 过滤参数
  report_by_id: z.string().optional(),
  // 本地过滤参数
  filter_project_id: z.string().optional(),
  filter_work_item_id: z.string().optional(),
  limit: z.number().optional().default(DEFAULT_LIMIT),
});

export type ListWorkloadsInput = z.infer<typeof ListWorkloadsInputSchema>;

// ============ 输出类型 ============

export interface WorkloadRecord {
  id: string;
  date: string;
  hours: number;
  user: {
    id: string;
    name: string;
    display_name: string;
  };
  work_item: {
    id: string;
    identifier: string;
    title: string;
    project: { id: string; name: string };
  } | null;
  description?: string;
}

export interface ListWorkloadsOutput {
  workloads: WorkloadRecord[];
  total: number;
  returned: number;
  data_quality: {
    time_sliced: boolean;
    pagination_truncated: boolean;
    result_truncated: boolean;
  };
}

export interface ListWorkloadsError {
  error: string;
  code: 'INVALID_TIME_RANGE' | 'INVALID_PARAMS' | 'USER_NOT_FOUND' | 'AMBIGUOUS_USER' | 'INTERNAL_ERROR';
  candidates?: Array<{ id: string; name: string; display_name: string }>;
}

export type ListWorkloadsResult = ListWorkloadsOutput | ListWorkloadsError;

// ============ Tool 实现 ============

export async function listWorkloads(input: ListWorkloadsInput): Promise<ListWorkloadsResult> {
  logger.info({ input }, 'list_workloads called');

  try {
    // 1. 解析 principal_type 和 principal_id
    let principalType: PrincipalType;
    let principalId: string;
    let resolvedUser: { id: string; name: string; display_name: string } | null = null;

    if (input.principal_type && input.principal_id) {
      // 使用新参数
      principalType = input.principal_type;
      principalId = input.principal_id;

      // 如果是 user 类型，获取用户信息用于输出
      if (principalType === 'user') {
        const user = await userService.getUser(principalId);
        if (user) {
          resolvedUser = { id: user.id, name: user.name, display_name: user.display_name };
        }
      }
    } else if (input.user) {
      // 兼容旧参数：user 字段
      principalType = 'user';

      if (input.user.id) {
        principalId = input.user.id;
        const user = await userService.getUser(principalId);
        if (!user) {
          return {
            error: `User not found: ${principalId}`,
            code: 'USER_NOT_FOUND',
          };
        }
        resolvedUser = { id: user.id, name: user.name, display_name: user.display_name };
      } else if (input.user.name) {
        const resolved = await userService.resolveUser({ name: input.user.name });
        if (!resolved.user) {
          if (resolved.ambiguous) {
            return {
              error: `Multiple users match "${input.user.name}". Please specify user ID.`,
              code: 'AMBIGUOUS_USER',
              candidates: resolved.candidates.map(c => ({
                id: c.user.id,
                name: c.user.name,
                display_name: c.user.display_name,
              })),
            };
          }
          return {
            error: `User not found: ${input.user.name}`,
            code: 'USER_NOT_FOUND',
          };
        }
        principalId = resolved.user.id;
        resolvedUser = { id: resolved.user.id, name: resolved.user.name, display_name: resolved.user.display_name };
      } else {
        return {
          error: 'Either user.id or user.name must be provided',
          code: 'INVALID_PARAMS',
        };
      }
    } else {
      return {
        error: 'Must provide principal_type/principal_id or user parameter',
        code: 'INVALID_PARAMS',
      };
    }

    // 2. 解析时间范围
    let timeRange;
    try {
      timeRange = parseTimeRange(input.time_range.start, input.time_range.end);
    } catch (error) {
      return {
        error: `Invalid time range: ${(error as Error).message}`,
        code: 'INVALID_TIME_RANGE',
      };
    }

    // 3. 获取工时数据
    const result = await apiListWorkloads({
      principalType,
      principalId,
      startAt: timeRange.start,
      endAt: timeRange.end,
      reportById: input.report_by_id,
    });

    // 4. 获取工作项详情
    const { workItems } = await workItemService.enrichWorkloadsWithWorkItems(result.workloads);

    // 5. 如果是 project/work_item 类型，批量获取用户信息
    let usersMap = new Map<string, { id: string; name: string; display_name: string }>();
    if (principalType !== 'user') {
      const userIds = [...new Set(result.workloads.map(w => w.user_id))];
      const users = await userService.getUsersMap(userIds);
      usersMap = new Map(
        [...users.entries()].map(([id, u]) => [id, { id: u.id, name: u.name, display_name: u.display_name }])
      );
    }

    // 6. 过滤
    let workloads = result.workloads;

    // 按项目过滤（本地）
    if (input.filter_project_id) {
      workloads = workloads.filter(w => {
        if (w.project_id === input.filter_project_id) return true;
        if (!w.work_item_id) return false;
        const workItem = workItems.get(w.work_item_id);
        return workItem?.project.id === input.filter_project_id;
      });
    }

    // 按工作项过滤（本地）
    if (input.filter_work_item_id) {
      workloads = workloads.filter(w => w.work_item_id === input.filter_work_item_id);
    }

    // 7. 应用硬上限
    const total = workloads.length;
    const effectiveLimit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const resultTruncated = workloads.length > effectiveLimit;
    workloads = workloads.slice(0, effectiveLimit);

    // 8. 格式化输出
    const formattedWorkloads: WorkloadRecord[] = workloads.map(w => {
      const workItem = w.work_item_id ? workItems.get(w.work_item_id) : null;
      // 获取用户信息：优先用 resolvedUser（user 类型），否则从 usersMap 获取
      const userInfo = resolvedUser || usersMap.get(w.user_id) || {
        id: w.user_id,
        name: w.user_id,
        display_name: `[Unknown User: ${w.user_id}]`,
      };
      return {
        id: w.id,
        date: formatTimestamp(w.date_at),
        hours: w.hours,
        user: userInfo,
        work_item: workItem ? {
          id: workItem.id,
          identifier: workItem.identifier,
          title: workItem.title,
          project: {
            id: workItem.project.id,
            name: workItem.project.name,
          },
        } : null,
        description: w.description,
      };
    });

    return {
      workloads: formattedWorkloads,
      total,
      returned: formattedWorkloads.length,
      data_quality: {
        time_sliced: result.timeSliced,
        pagination_truncated: result.paginationTruncated,
        result_truncated: resultTruncated,
      },
    };
  } catch (error) {
    logger.error({ error, input }, 'list_workloads failed');
    return {
      error: `Internal error: ${(error as Error).message}`,
      code: 'INTERNAL_ERROR',
    };
  }
}

// ============ MCP Tool 定义 ============

export const listWorkloadsToolDefinition = {
  name: 'list_workloads',
  description: `获取工时记录列表。

支持三种查询维度：
- user: 按用户查询
- project: 按项目查询
- work_item: 按工作项查询

参数说明：
- principal_type + principal_id: 新参数，指定查询维度和 ID
- user: 兼容旧参数，等同于 principal_type=user

返回：
- workloads: 工时记录列表（含用户、工作项详情）
- total: 匹配的总数
- returned: 本次返回数量
- data_quality: 数据质量指标`,
  inputSchema: {
    type: 'object',
    properties: {
      principal_type: {
        type: 'string',
        enum: ['user', 'project', 'work_item'],
        description: '查询维度：user（按用户）、project（按项目）、work_item（按工作项）',
      },
      principal_id: {
        type: 'string',
        description: '对应维度的 ID',
      },
      user: {
        type: 'object',
        description: '用户标识（兼容旧参数，等同于 principal_type=user）',
        properties: {
          id: { type: 'string', description: '用户 ID' },
          name: { type: 'string', description: '用户名或显示名' },
        },
      },
      time_range: {
        type: 'object',
        description: '时间范围',
        properties: {
          start: { type: 'string', description: '开始时间，如 "2026-01-01" 或 "上周"' },
          end: { type: 'string', description: '结束时间，如 "2026-01-31" 或 "今天"' },
        },
        required: ['start', 'end'],
      },
      report_by_id: {
        type: 'string',
        description: '按填报人 ID 过滤（API 级过滤）',
      },
      filter_project_id: {
        type: 'string',
        description: '本地过滤：按项目 ID（可选）',
      },
      filter_work_item_id: {
        type: 'string',
        description: '本地过滤：按工作项 ID（可选）',
      },
      limit: {
        type: 'number',
        description: '返回数量限制，默认 100，最大 500',
      },
    },
    required: ['time_range'],
  },
};
