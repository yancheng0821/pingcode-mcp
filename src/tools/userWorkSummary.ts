import { z } from 'zod';
import { userService } from '../services/userService.js';
import { workloadService, type UserWorkResult, type GroupBy } from '../services/workloadService.js';
import { parseTimeRange } from '../utils/timeUtils.js';
import { logger } from '../utils/logger.js';

// ============ Schema 定义 ============

export const UserWorkSummaryInputSchema = z.object({
  user: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
  }).refine(data => data.id || data.name, {
    message: 'Either user.id or user.name is required',
  }),
  time_range: z.object({
    start: z.string(),
    end: z.string(),
  }),
  group_by: z.enum(['day', 'week', 'month', 'work_item', 'project', 'type']).optional().default('work_item'),
  top_n: z.number().optional().default(10),
});

export type UserWorkSummaryInput = z.infer<typeof UserWorkSummaryInputSchema>;

// ============ 输出类型 ============

export interface UserWorkSummaryOutput {
  summary: {
    user: {
      id: string;
      name: string;
      display_name: string;
    };
    time_range: {
      start_at: number;
      end_at: number;
    };
    total_hours: number;
    by_project: Array<{
      project: { id: string; name: string };
      hours: number;
    }>;
    by_work_item: Array<{
      work_item: { id: string; identifier: string; title: string; project: { id: string; name: string } };
      hours: number;
    }>;
    by_day?: Array<{ date: string; hours: number }>;
    by_week?: Array<{ week: string; hours: number }>;
    by_month?: Array<{ month: string; hours: number }>;
  };
  details: Array<{
    date: string;
    workload_id: string;
    hours: number;
    work_item: {
      identifier: string;
      title: string;
      project: { id: string; name: string };
    } | null;
    description?: string;
  }>;
  data_quality: {
    workloads_count: number;
    missing_work_item_count: number;
    unknown_user_match: boolean;
    time_sliced: boolean;
    pagination_truncated: boolean;
    details_truncated: boolean;
  };
}

export interface UserWorkSummaryError {
  error: string;
  code: 'USER_NOT_FOUND' | 'USER_AMBIGUOUS' | 'INVALID_TIME_RANGE' | 'NO_DATA' | 'INTERNAL_ERROR';
  candidates?: Array<{
    id: string;
    name: string;
    display_name: string;
    match_type: string;
  }>;
}

export type UserWorkSummaryResult = UserWorkSummaryOutput | UserWorkSummaryError;

// ============ Tool 实现 ============

export async function userWorkSummary(input: UserWorkSummaryInput): Promise<UserWorkSummaryResult> {
  logger.info({ input }, 'user_work_summary called');

  try {
    // 1. 解析用户
    const userResult = await userService.resolveUser(input.user);

    if (userResult.ambiguous) {
      logger.warn({
        input: input.user,
        candidatesCount: userResult.candidates.length,
      }, 'User match ambiguous');

      return {
        error: `Multiple users match "${input.user.name}". Please specify user.id or provide a more specific name.`,
        code: 'USER_AMBIGUOUS',
        candidates: userResult.candidates.map(c => ({
          id: c.user.id,
          name: c.user.name,
          display_name: c.user.display_name,
          match_type: c.matchType,
        })),
      };
    }

    if (!userResult.user) {
      return {
        error: `User not found: ${input.user.id || input.user.name}`,
        code: 'USER_NOT_FOUND',
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

    // 3. 获取工时汇总
    const result = await workloadService.getUserWorkSummary(
      userResult.user.id,
      timeRange.start,
      timeRange.end,
      {
        groupBy: input.group_by as GroupBy,
        topN: input.top_n,
      }
    );

    // 4. 检查是否有数据
    if (result.data_quality.workloads_count === 0) {
      const startDate = new Date(timeRange.start * 1000).toISOString().split('T')[0];
      const endDate = new Date(timeRange.end * 1000).toISOString().split('T')[0];
      return {
        error: `用户 "${userResult.user.display_name}" 在 ${startDate} 至 ${endDate} 期间没有工时记录。`,
        code: 'NO_DATA',
      };
    }

    // 5. 格式化输出
    return formatOutput(result);
  } catch (error) {
    logger.error({ error, input }, 'user_work_summary failed');

    return {
      error: `Internal error: ${(error as Error).message}`,
      code: 'INTERNAL_ERROR',
    };
  }
}

// ============ 辅助函数 ============

function formatOutput(result: UserWorkResult): UserWorkSummaryOutput {
  return {
    summary: {
      user: {
        id: result.summary.user.id,
        name: result.summary.user.name,
        display_name: result.summary.user.display_name,
      },
      time_range: result.summary.time_range,
      total_hours: result.summary.total_hours,
      by_project: result.summary.by_project.map(p => ({
        project: { id: p.project.id, name: p.project.name },
        hours: p.hours,
      })),
      by_work_item: result.summary.by_work_item.map(w => ({
        work_item: {
          id: w.work_item.id,
          identifier: w.work_item.identifier,
          title: w.work_item.title,
          project: { id: w.work_item.project.id, name: w.work_item.project.name },
        },
        hours: w.hours,
      })),
      by_day: result.summary.by_day,
      by_week: result.summary.by_week,
      by_month: result.summary.by_month,
    },
    details: result.details.map(d => ({
      date: d.date,
      workload_id: d.workload_id,
      hours: d.hours,
      work_item: d.work_item ? {
        identifier: d.work_item.identifier,
        title: d.work_item.title,
        project: { id: d.work_item.project.id, name: d.work_item.project.name },
      } : null,
      description: d.description,
    })),
    data_quality: result.data_quality,
  };
}

// ============ MCP Tool 定义 ============

export const userWorkSummaryToolDefinition = {
  name: 'user_work_summary',
  description: `查询单个用户在指定时间段内做了什么、工时多少。

支持：
- 按用户 ID 或姓名查询
- 时间范围支持日期格式（如 "2026-01-01"）或别名（如 "last_week"、"this_month"）
- 多种聚合维度：按日、周、月、工作项、项目
- 自动处理超过 3 个月的时间分片

返回：
- summary: 汇总信息（总工时、按项目/工作项分布）
- details: 工时明细列表
- data_quality: 数据质量指标`,
  inputSchema: {
    type: 'object',
    properties: {
      user: {
        type: 'object',
        description: '用户标识（id 或 name 二选一）',
        properties: {
          id: { type: 'string', description: '用户 ID' },
          name: { type: 'string', description: '用户姓名（支持模糊匹配）' },
        },
      },
      time_range: {
        type: 'object',
        description: '时间范围',
        properties: {
          start: { type: 'string', description: '开始时间，如 "2026-01-01" 或 "last_week"' },
          end: { type: 'string', description: '结束时间，如 "2026-01-31" 或 "today"' },
        },
        required: ['start', 'end'],
      },
      group_by: {
        type: 'string',
        enum: ['day', 'week', 'month', 'work_item', 'project'],
        description: '聚合维度，默认 "work_item"',
      },
      top_n: {
        type: 'number',
        description: '返回 Top N 工作项/项目，默认 10',
      },
    },
    required: ['user', 'time_range'],
  },
};
