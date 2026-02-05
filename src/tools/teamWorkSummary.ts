import { z } from 'zod';
import { workloadService, type TeamWorkResult, type TeamGroupBy } from '../services/workloadService.js';
import { parseTimeRange } from '../utils/timeUtils.js';
import { logger } from '../utils/logger.js';

// ============ Schema 定义 ============

export const TeamWorkSummaryInputSchema = z.object({
  time_range: z.object({
    start: z.string(),
    end: z.string(),
  }),
  user_ids: z.array(z.string()).optional(),
  project_id: z.string().optional(),
  group_by: z.enum(['user', 'project', 'work_item', 'day', 'week', 'month']).optional().default('user'),
  top_n: z.number().optional().default(5),
  include_matrix: z.boolean().optional().default(false),
});

export type TeamWorkSummaryInput = z.infer<typeof TeamWorkSummaryInputSchema>;

// ============ 输出类型 ============

export interface TeamWorkSummaryOutput {
  summary: {
    time_range: {
      start_at: number;
      end_at: number;
    };
    total_hours: number;
    user_count: number;
    members: Array<{
      user: {
        id: string;
        name: string;
        display_name: string;
      };
      total_hours: number;
      // 默认输出（group_by=user 时）
      top_projects?: Array<{
        project: { id: string; name: string };
        hours: number;
      }>;
      top_work_items?: Array<{
        work_item: { id: string; identifier: string; title: string };
        hours: number;
      }>;
      // 时间维度聚合
      by_day?: Array<{ date: string; hours: number }>;
      by_week?: Array<{ week: string; hours: number }>;
      by_month?: Array<{ month: string; hours: number }>;
      // 项目/工作项维度
      by_project?: Array<{ project: { id: string; name: string }; hours: number }>;
      by_work_item?: Array<{ work_item: { id: string; identifier: string; title: string }; hours: number }>;
    }>;
    // 按时间维度聚合
    by_day?: Array<{ date: string; hours: number }>;
    by_week?: Array<{ week: string; hours: number }>;
    by_month?: Array<{ month: string; hours: number }>;
    // 按项目/工作项聚合
    by_project?: Array<{ project: { id: string; name: string }; hours: number }>;
    by_work_item?: Array<{ work_item: { id: string; identifier: string; title: string }; hours: number }>;
  };
  details: Array<{
    date: string;
    workload_id: string;
    hours: number;
    user: { id: string; name: string; display_name: string };
    work_item: { id: string; identifier: string; title: string } | null;
    project: { id: string; identifier: string; name: string } | null;
    description?: string;
  }>;
  by_day_matrix?: {
    dates: string[];
    rows: Array<{
      user: { id: string; name: string; display_name: string };
      hours_per_day: number[];
    }>;
  };
  data_quality: {
    workloads_count: number;
    missing_work_item_count: number;
    unknown_user_matches: number;
    time_sliced: boolean;
    pagination_truncated: boolean;
    details_truncated: boolean;
  };
}

export interface TeamWorkSummaryError {
  error: string;
  code: 'INVALID_TIME_RANGE' | 'NO_USERS' | 'NO_DATA' | 'INTERNAL_ERROR';
}

export type TeamWorkSummaryResult = TeamWorkSummaryOutput | TeamWorkSummaryError;

// ============ Tool 实现 ============

export async function teamWorkSummary(input: TeamWorkSummaryInput): Promise<TeamWorkSummaryResult> {
  logger.info({ input }, 'team_work_summary called');

  try {
    // 1. 解析时间范围
    let timeRange;
    try {
      timeRange = parseTimeRange(input.time_range.start, input.time_range.end);
    } catch (error) {
      return {
        error: `Invalid time range: ${(error as Error).message}`,
        code: 'INVALID_TIME_RANGE',
      };
    }

    // 2. 验证用户列表（如果指定）
    if (input.user_ids && input.user_ids.length === 0) {
      return {
        error: 'user_ids cannot be an empty array. Omit it to query all users.',
        code: 'NO_USERS',
      };
    }

    // 3. 获取团队工时汇总
    const result = await workloadService.getTeamWorkSummary(
      timeRange.start,
      timeRange.end,
      {
        userIds: input.user_ids,
        projectId: input.project_id,
        groupBy: input.group_by as TeamGroupBy,
        topN: input.top_n,
        includeMatrix: input.include_matrix,
      }
    );

    // 4. 检查是否有数据
    if (result.data_quality.workloads_count === 0) {
      const startDate = new Date(timeRange.start * 1000).toISOString().split('T')[0];
      const endDate = new Date(timeRange.end * 1000).toISOString().split('T')[0];
      return {
        error: `在 ${startDate} 至 ${endDate} 期间没有找到任何工时记录。请确认时间范围是否正确，或者该时间段内是否有人填报过工时。`,
        code: 'NO_DATA',
      };
    }

    // 5. 格式化输出
    return formatOutput(result);
  } catch (error) {
    logger.error({ error, input }, 'team_work_summary failed');

    return {
      error: `Internal error: ${(error as Error).message}`,
      code: 'INTERNAL_ERROR',
    };
  }
}

// ============ 辅助函数 ============

function formatOutput(result: TeamWorkResult): TeamWorkSummaryOutput {
  const output: TeamWorkSummaryOutput = {
    summary: {
      time_range: result.summary.time_range,
      total_hours: result.summary.total_hours,
      user_count: result.summary.user_count,
      members: result.summary.members.map(m => {
        const member: TeamWorkSummaryOutput['summary']['members'][0] = {
          user: {
            id: m.user.id,
            name: m.user.name,
            display_name: m.user.display_name,
          },
          total_hours: m.total_hours,
        };

        // 根据成员数据中存在的字段添加对应输出
        if (m.top_projects) {
          member.top_projects = m.top_projects.map(p => ({
            project: { id: p.project.id, name: p.project.name },
            hours: p.hours,
          }));
        }
        if (m.top_work_items) {
          member.top_work_items = m.top_work_items.map(w => ({
            work_item: {
              id: w.work_item.id,
              identifier: w.work_item.identifier,
              title: w.work_item.title,
            },
            hours: w.hours,
          }));
        }
        if (m.by_day) {
          member.by_day = m.by_day;
        }
        if (m.by_week) {
          member.by_week = m.by_week;
        }
        if (m.by_month) {
          member.by_month = m.by_month;
        }
        if (m.by_project) {
          member.by_project = m.by_project.map(p => ({
            project: { id: p.project.id, name: p.project.name },
            hours: p.hours,
          }));
        }
        if (m.by_work_item) {
          member.by_work_item = m.by_work_item.map(w => ({
            work_item: {
              id: w.work_item.id,
              identifier: w.work_item.identifier,
              title: w.work_item.title,
            },
            hours: w.hours,
          }));
        }

        return member;
      }),
    },
    details: result.details.map(d => ({
      date: d.date,
      workload_id: d.workload_id,
      hours: d.hours,
      user: {
        id: d.user.id,
        name: d.user.name,
        display_name: d.user.display_name,
      },
      work_item: d.work_item ? {
        id: d.work_item.id,
        identifier: d.work_item.identifier,
        title: d.work_item.title,
      } : null,
      project: d.project ? {
        id: d.project.id,
        identifier: d.project.identifier,
        name: d.project.name,
      } : null,
      description: d.description,
    })),
    data_quality: result.data_quality,
  };

  // 添加时间维度聚合
  if (result.summary.by_day) {
    output.summary.by_day = result.summary.by_day;
  }
  if (result.summary.by_week) {
    output.summary.by_week = result.summary.by_week;
  }
  if (result.summary.by_month) {
    output.summary.by_month = result.summary.by_month;
  }

  // 添加项目/工作项聚合
  if (result.summary.by_project) {
    output.summary.by_project = result.summary.by_project.map(p => ({
      project: { id: p.project.id, name: p.project.name },
      hours: p.hours,
    }));
  }
  if (result.summary.by_work_item) {
    output.summary.by_work_item = result.summary.by_work_item.map(w => ({
      work_item: {
        id: w.work_item.id,
        identifier: w.work_item.identifier,
        title: w.work_item.title,
      },
      hours: w.hours,
    }));
  }

  if (result.by_day_matrix) {
    output.by_day_matrix = {
      dates: result.by_day_matrix.dates,
      rows: result.by_day_matrix.rows.map(r => ({
        user: {
          id: r.user.id,
          name: r.user.name,
          display_name: r.user.display_name,
        },
        hours_per_day: r.hours_per_day,
      })),
    };
  }

  return output;
}

// ============ MCP Tool 定义 ============

export const teamWorkSummaryToolDefinition = {
  name: 'team_work_summary',
  description: `查询团队在指定时间段内每个人做了什么、工时分布。

支持：
- 查询全员或指定用户列表
- 按项目过滤
- 时间范围支持日期格式或别名（如 "last_week"）
- 可选返回人天矩阵

返回：
- summary: 团队汇总（总工时、成员列表及各自 Top 项目/工作项）
- by_day_matrix: 可选的人天矩阵
- data_quality: 数据质量指标`,
  inputSchema: {
    type: 'object',
    properties: {
      time_range: {
        type: 'object',
        description: '时间范围',
        properties: {
          start: { type: 'string', description: '开始时间，如 "2026-01-01" 或 "last_month"' },
          end: { type: 'string', description: '结束时间，如 "2026-01-31" 或 "today"' },
        },
        required: ['start', 'end'],
      },
      user_ids: {
        type: 'array',
        items: { type: 'string' },
        description: '用户 ID 列表（不传则查全员）',
      },
      project_id: {
        type: 'string',
        description: '项目 ID（可选，只看某项目投入）',
      },
      group_by: {
        type: 'string',
        enum: ['user', 'project', 'work_item', 'day', 'week', 'month'],
        description: '聚合维度，默认 "user"',
      },
      top_n: {
        type: 'number',
        description: '每人返回 Top N 工作项/项目，默认 5',
      },
      include_matrix: {
        type: 'boolean',
        description: '是否返回人天矩阵，默认 false',
      },
    },
    required: ['time_range'],
  },
};
