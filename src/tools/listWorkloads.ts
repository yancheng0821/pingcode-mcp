import { z } from 'zod';
import { listWorkloads as apiListWorkloads } from '../api/endpoints/workloads.js';
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
  // 用户过滤
  user: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
  }).optional(),
  // 时间范围
  time_range: z.object({
    start: z.string(),
    end: z.string(),
  }),
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
  project: {
    id: string;
    identifier: string;
    name: string;
  };
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
  code: 'INVALID_TIME_RANGE' | 'INVALID_PARAMS' | 'USER_NOT_FOUND' | 'AMBIGUOUS_USER' | 'NO_DATA' | 'INTERNAL_ERROR';
  candidates?: Array<{ id: string; name: string; display_name: string }>;
}

export type ListWorkloadsResult = ListWorkloadsOutput | ListWorkloadsError;

// ============ Tool 实现 ============

export async function listWorkloads(input: ListWorkloadsInput): Promise<ListWorkloadsResult> {
  logger.info({ input }, 'list_workloads called');

  try {
    // 1. 解析用户参数（如果提供）
    let filterUserId: string | undefined;
    if (input.user) {
      if (input.user.id) {
        filterUserId = input.user.id;
        const user = await userService.getUser(filterUserId);
        if (!user) {
          return {
            error: `User not found: ${filterUserId}`,
            code: 'USER_NOT_FOUND',
          };
        }
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
        filterUserId = resolved.user.id;
      }
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
      startAt: timeRange.start,
      endAt: timeRange.end,
      userId: filterUserId,
      projectId: input.filter_project_id,
    });

    // 4. 获取工作项详情（可选增强）
    const { workItems } = await workItemService.enrichWorkloadsWithWorkItems(result.workloads);

    // 5. 过滤
    let workloads = result.workloads;

    // 按工作项过滤（本地）
    if (input.filter_work_item_id) {
      workloads = workloads.filter(w => w.work_item?.id === input.filter_work_item_id);
    }

    // 6. 检查是否有数据
    if (workloads.length === 0) {
      const startDate = new Date(timeRange.start * 1000).toISOString().split('T')[0];
      const endDate = new Date(timeRange.end * 1000).toISOString().split('T')[0];
      return {
        error: `在 ${startDate} 至 ${endDate} 期间没有找到工时记录。`,
        code: 'NO_DATA',
      };
    }

    // 7. 应用硬上限
    const total = workloads.length;
    const effectiveLimit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const resultTruncated = workloads.length > effectiveLimit;
    workloads = workloads.slice(0, effectiveLimit);

    // 8. 格式化输出
    const formattedWorkloads: WorkloadRecord[] = workloads.map(w => {
      // 获取工作项详情（优先使用缓存的详细信息）
      let workItem = null;
      if (w.work_item) {
        const cachedWorkItem = workItems.get(w.work_item.id);
        workItem = {
          id: w.work_item.id,
          identifier: w.work_item.identifier,
          title: w.work_item.title,
          project: {
            id: w.project.id,
            name: w.project.name,
          },
        };
        // 如果有缓存的详细信息，使用缓存的标题（可能更完整）
        if (cachedWorkItem) {
          workItem.title = cachedWorkItem.title;
        }
      }

      return {
        id: w.id,
        date: formatTimestamp(w.report_at),
        hours: w.duration,
        user: {
          id: w.report_by.id,
          name: w.report_by.name,
          display_name: w.report_by.display_name,
        },
        work_item: workItem,
        project: {
          id: w.project.id,
          identifier: w.project.identifier,
          name: w.project.name,
        },
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

支持按用户、项目、工作项过滤。

参数说明：
- user: 按用户过滤（可选）
- time_range: 时间范围（必填）
- filter_project_id: 按项目 ID 过滤（可选）
- filter_work_item_id: 按工作项 ID 过滤（可选）

返回：
- workloads: 工时记录列表（含用户、工作项、项目详情）
- total: 匹配的总数
- returned: 本次返回数量
- data_quality: 数据质量指标`,
  inputSchema: {
    type: 'object',
    properties: {
      user: {
        type: 'object',
        description: '按用户过滤（可选）',
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
      filter_project_id: {
        type: 'string',
        description: '按项目 ID 过滤（可选）',
      },
      filter_work_item_id: {
        type: 'string',
        description: '按工作项 ID 过滤（可选）',
      },
      limit: {
        type: 'number',
        description: '返回数量限制，默认 100，最大 500',
      },
    },
    required: ['time_range'],
  },
};
