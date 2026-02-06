import {
  listUserWorkloads,
  listWorkloadsForUsers,
  type WorkloadsResult,
} from '../api/endpoints/workloads.js';
import { userService, type UserInfo } from './userService.js';
import { workItemService, type WorkItemInfo, type ProjectInfo } from './workItemService.js';
import { formatTimestamp } from '../utils/timeUtils.js';
import type { PingCodeWorkload } from '../api/types.js';

// ============ 常量 ============

const MAX_DETAILS_LIMIT = 500;

// ============ 输出类型定义 ============

export interface WorkloadDetail {
  date: string;
  workload_id: string;
  hours: number;
  work_item: WorkItemInfo | null;
  description?: string;
}

export interface HoursByProject {
  project: ProjectInfo;
  hours: number;
}

export interface HoursByWorkItem {
  work_item: WorkItemInfo;
  hours: number;
}

export interface HoursByDay {
  date: string;
  hours: number;
}

export interface HoursByWeek {
  week: string;  // e.g., "2026-W05"
  hours: number;
}

export interface HoursByMonth {
  month: string;  // e.g., "2026-01"
  hours: number;
}

export interface HoursByType {
  type: string;
  hours: number;
}

export interface DataQuality {
  workloads_count: number;
  missing_work_item_count: number;
  unknown_user_match: boolean;
  time_sliced: boolean;
  pagination_truncated: boolean;
  details_truncated: boolean;
}

export interface UserWorkSummary {
  user: UserInfo;
  time_range: {
    start_at: number;
    end_at: number;
  };
  total_hours: number;
  by_project: HoursByProject[];
  by_work_item: HoursByWorkItem[];
  by_day?: HoursByDay[];
  by_week?: HoursByWeek[];
  by_month?: HoursByMonth[];
  by_type?: HoursByType[];
}

export interface UserWorkResult {
  summary: UserWorkSummary;
  details: WorkloadDetail[];
  data_quality: DataQuality;
}

export interface TeamMemberSummary {
  user: UserInfo;
  total_hours: number;
  // 默认输出（group_by=user 时）
  top_projects?: HoursByProject[];
  top_work_items?: HoursByWorkItem[];
  // 时间维度聚合（group_by=day/week/month 时）
  by_day?: HoursByDay[];
  by_week?: HoursByWeek[];
  by_month?: HoursByMonth[];
  // 项目/工作项维度（group_by=project/work_item 时）
  by_project?: HoursByProject[];
  by_work_item?: HoursByWorkItem[];
  // 类型维度（group_by=type 时）
  by_type?: HoursByType[];
}

export interface TeamWorkSummary {
  time_range: {
    start_at: number;
    end_at: number;
  };
  total_hours: number;
  user_count: number;
  members: TeamMemberSummary[];
  // 按时间维度聚合（当 group_by 为 day/week/month 时）
  by_day?: HoursByDay[];
  by_week?: HoursByWeek[];
  by_month?: HoursByMonth[];
  // 按项目/工作项聚合（当 group_by 为 project/work_item 时）
  by_project?: HoursByProject[];
  by_work_item?: HoursByWorkItem[];
  // 按类型聚合（当 group_by 为 type 时）
  by_type?: HoursByType[];
}

export type TeamGroupBy = 'user' | 'project' | 'work_item' | 'day' | 'week' | 'month' | 'type';

export interface DayMatrixRow {
  user: UserInfo;
  hours_per_day: number[];
}

export interface TeamWorkloadDetail {
  date: string;
  workload_id: string;
  hours: number;
  user: UserInfo;
  work_item: WorkItemInfo | null;
  project: ProjectInfo | null;
  description?: string;
}

export interface TeamWorkResult {
  summary: TeamWorkSummary;
  details: TeamWorkloadDetail[];
  by_day_matrix?: {
    dates: string[];
    rows: DayMatrixRow[];
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

export type GroupBy = 'day' | 'week' | 'month' | 'work_item' | 'project' | 'type';

// ============ 工时服务 ============

export class WorkloadService {
  /**
   * 获取用户工时汇总
   */
  async getUserWorkSummary(
    userId: string,
    startAt: number,
    endAt: number,
    options: {
      groupBy?: GroupBy;
      topN?: number;
    } = {}
  ): Promise<UserWorkResult> {
    const { groupBy = 'work_item', topN = 10 } = options;

    // 1. 获取用户信息
    const user = await userService.getUser(userId);
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    // 2. 获取工时数据
    const workloadsResult = await listUserWorkloads(userId, startAt, endAt);
    const { workloads, timeSliced, paginationTruncated } = workloadsResult;

    // 3. 获取工作项详情
    const { workItems, missingCount } = await workItemService.enrichWorkloadsWithWorkItems(workloads);

    // 4. 聚合计算
    const aggregated = this.aggregateWorkloads(workloads, workItems, groupBy, topN);

    // 5. 构建详情列表（带上限）
    const allDetails = this.buildDetails(workloads, workItems);
    const detailsTruncated = allDetails.length > MAX_DETAILS_LIMIT;
    const details = allDetails.slice(0, MAX_DETAILS_LIMIT);

    // 6. 构建返回结果
    const summary: UserWorkSummary = {
      user,
      time_range: { start_at: startAt, end_at: endAt },
      total_hours: aggregated.totalHours,
      by_project: aggregated.byProject.slice(0, topN),
      by_work_item: aggregated.byWorkItem.slice(0, topN),
    };

    // 添加时间/类型维度分组
    if (groupBy === 'day') {
      summary.by_day = aggregated.byDay;
    } else if (groupBy === 'week') {
      summary.by_week = aggregated.byWeek;
    } else if (groupBy === 'month') {
      summary.by_month = aggregated.byMonth;
    } else if (groupBy === 'type') {
      summary.by_type = aggregated.byType;
    }

    return {
      summary,
      details,
      data_quality: {
        workloads_count: workloads.length,
        missing_work_item_count: missingCount,
        unknown_user_match: false,
        time_sliced: timeSliced,
        pagination_truncated: paginationTruncated,
        details_truncated: detailsTruncated,
      },
    };
  }

  /**
   * 获取团队工时汇总
   */
  async getTeamWorkSummary(
    startAt: number,
    endAt: number,
    options: {
      userIds?: string[];
      projectId?: string;
      groupBy?: TeamGroupBy;
      topN?: number;
      includeMatrix?: boolean;
    } = {}
  ): Promise<TeamWorkResult> {
    const { userIds, projectId, groupBy = 'user', topN = 5, includeMatrix = false } = options;

    // 1. 获取用户列表
    let targetUserIds: string[];
    if (userIds && userIds.length > 0) {
      targetUserIds = userIds;
    } else {
      const allUsers = await userService.getAllUsers();
      targetUserIds = allUsers.map(u => u.id);
    }

    // 2. 批量获取工时数据
    const workloadsMap = await listWorkloadsForUsers(targetUserIds, startAt, endAt);

    // 3. 获取用户信息
    const usersMap = await userService.getUsersMap(targetUserIds);

    // 4. 收集所有工时记录
    const allWorkloads: PingCodeWorkload[] = [];
    for (const result of workloadsMap.values()) {
      allWorkloads.push(...result.workloads);
    }

    // 5. 获取工作项详情
    const { workItems } = await workItemService.enrichWorkloadsWithWorkItems(allWorkloads);

    // 6. 按项目过滤（如果指定）
    let filteredWorkloadsMap = workloadsMap;
    if (projectId) {
      filteredWorkloadsMap = this.filterByProject(workloadsMap, workItems, projectId);
    }

    // 7. 聚合每个用户的数据
    const members: TeamMemberSummary[] = [];
    const allDetails: TeamWorkloadDetail[] = [];
    let totalHours = 0;
    let totalWorkloadsCount = 0;
    let totalMissingWorkItemCount = 0;
    let anyTimeSliced = false;
    let anyPaginationTruncated = false;

    for (const [userId, result] of filteredWorkloadsMap) {
      const user = usersMap.get(userId);
      if (!user) continue;

      const aggregated = this.aggregateWorkloads(result.workloads, workItems, groupBy as GroupBy, topN);

      if (aggregated.totalHours > 0) {
        // 根据 groupBy 构建成员聚合数据
        const memberSummary: TeamMemberSummary = {
          user,
          total_hours: aggregated.totalHours,
        };

        // 根据 groupBy 决定成员层级的输出字段
        switch (groupBy) {
          case 'day':
            memberSummary.by_day = aggregated.byDay;
            break;
          case 'week':
            memberSummary.by_week = aggregated.byWeek;
            break;
          case 'month':
            memberSummary.by_month = aggregated.byMonth;
            break;
          case 'project':
            memberSummary.by_project = aggregated.byProject.slice(0, topN);
            break;
          case 'work_item':
            memberSummary.by_work_item = aggregated.byWorkItem.slice(0, topN);
            break;
          case 'type':
            memberSummary.by_type = aggregated.byType;
            break;
          case 'user':
          default:
            // 默认：同时输出 top_projects 和 top_work_items
            memberSummary.top_projects = aggregated.byProject.slice(0, topN);
            memberSummary.top_work_items = aggregated.byWorkItem.slice(0, topN);
            break;
        }

        members.push(memberSummary);
        totalHours += aggregated.totalHours;
      }

      // 构建该用户的明细
      for (const w of result.workloads) {
        // 使用 workload 中嵌入的 work_item 信息，或尝试从缓存获取更详细的信息
        const embeddedWorkItem = w.work_item;
        let workItem: WorkItemInfo | null = null;
        let project: ProjectInfo | null = null;

        if (embeddedWorkItem) {
          const cachedWorkItem = workItems.get(embeddedWorkItem.id);
          if (cachedWorkItem) {
            workItem = cachedWorkItem;
            project = cachedWorkItem.project;
          } else {
            // 没有缓存的工作项信息，使用嵌入的基本信息
            workItem = {
              id: embeddedWorkItem.id,
              identifier: embeddedWorkItem.identifier,
              title: embeddedWorkItem.title,
              type: embeddedWorkItem.type,
              project: { id: '', identifier: '', name: 'Unknown' },
            };
          }
        }
        allDetails.push({
          date: formatTimestamp(w.report_at),
          workload_id: w.id,
          hours: w.duration,
          user,
          work_item: workItem,
          project,
          description: w.description,
        });
      }

      totalWorkloadsCount += result.workloads.length;
      anyTimeSliced = anyTimeSliced || result.timeSliced;
      anyPaginationTruncated = anyPaginationTruncated || result.paginationTruncated;
    }

    // 8. 按总工时排序
    members.sort((a, b) => b.total_hours - a.total_hours);

    // 明细按日期倒序排序
    allDetails.sort((a, b) => b.date.localeCompare(a.date));

    // 限制明细数量
    const detailsTruncated = allDetails.length > MAX_DETAILS_LIMIT;
    const truncatedDetails = allDetails.slice(0, MAX_DETAILS_LIMIT);

    // 9. 根据 groupBy 计算额外聚合维度
    const allFilteredWorkloads: PingCodeWorkload[] = [];
    for (const result of filteredWorkloadsMap.values()) {
      allFilteredWorkloads.push(...result.workloads);
    }
    const teamAggregated = this.aggregateWorkloads(allFilteredWorkloads, workItems, groupBy as GroupBy, topN);

    // 10. 构建返回结果
    const teamResult: TeamWorkResult = {
      summary: {
        time_range: { start_at: startAt, end_at: endAt },
        total_hours: totalHours,
        user_count: members.length,
        members,
      },
      details: truncatedDetails,
      data_quality: {
        workloads_count: totalWorkloadsCount,
        missing_work_item_count: totalMissingWorkItemCount,
        unknown_user_matches: targetUserIds.length - usersMap.size,
        time_sliced: anyTimeSliced,
        pagination_truncated: anyPaginationTruncated,
        details_truncated: detailsTruncated,
      },
    };

    // 根据 groupBy 添加对应的聚合维度
    if (groupBy === 'day') {
      teamResult.summary.by_day = teamAggregated.byDay;
    } else if (groupBy === 'week') {
      teamResult.summary.by_week = teamAggregated.byWeek;
    } else if (groupBy === 'month') {
      teamResult.summary.by_month = teamAggregated.byMonth;
    } else if (groupBy === 'project') {
      teamResult.summary.by_project = teamAggregated.byProject.slice(0, topN);
    } else if (groupBy === 'work_item') {
      teamResult.summary.by_work_item = teamAggregated.byWorkItem.slice(0, topN);
    } else if (groupBy === 'type') {
      teamResult.summary.by_type = teamAggregated.byType;
    }

    // 11. 构建人天矩阵（如果需要）
    if (includeMatrix) {
      teamResult.by_day_matrix = this.buildDayMatrix(filteredWorkloadsMap, usersMap, startAt, endAt);
    }

    return teamResult;
  }

  // ============ 私有方法 ============

  /**
   * 聚合工时数据
   */
  private aggregateWorkloads(
    workloads: PingCodeWorkload[],
    workItems: Map<string, WorkItemInfo>,
    _groupBy: GroupBy,
    _topN: number
  ): {
    totalHours: number;
    byProject: HoursByProject[];
    byWorkItem: HoursByWorkItem[];
    byDay: HoursByDay[];
    byWeek: HoursByWeek[];
    byMonth: HoursByMonth[];
    byType: HoursByType[];
  } {
    let totalHours = 0;
    const projectHours = new Map<string, { project: ProjectInfo; hours: number }>();
    const workItemHours = new Map<string, { workItem: WorkItemInfo; hours: number }>();
    const dayHours = new Map<string, number>();
    const weekHours = new Map<string, number>();
    const monthHours = new Map<string, number>();
    const typeHours = new Map<string, number>();

    for (const workload of workloads) {
      const hours = workload.duration || 0;
      totalHours += hours;

      // 按日期
      const date = formatTimestamp(workload.report_at);
      dayHours.set(date, (dayHours.get(date) || 0) + hours);

      // 按周
      const week = this.getWeekKey(workload.report_at);
      weekHours.set(week, (weekHours.get(week) || 0) + hours);

      // 按月
      const month = date.substring(0, 7);  // "2026-01"
      monthHours.set(month, (monthHours.get(month) || 0) + hours);

      // 按工时类型
      const workloadType = workload.type || 'unknown';
      typeHours.set(workloadType, (typeHours.get(workloadType) || 0) + hours);

      // 按项目（通过 work_item 获取 project 信息）
      let project: ProjectInfo | undefined;
      if (workload.work_item) {
        const cachedWorkItem = workItems.get(workload.work_item.id);
        project = cachedWorkItem?.project;
      }

      if (project) {
        const existingProject = projectHours.get(project.id);
        if (existingProject) {
          existingProject.hours += hours;
        } else {
          projectHours.set(project.id, { project, hours });
        }
      }

      // 按工作项
      if (workload.work_item) {
        const embeddedWorkItem = workload.work_item;
        // 优先使用缓存的详细信息，否则使用嵌入的基本信息
        const cachedWorkItem = workItems.get(embeddedWorkItem.id);
        const workItem: WorkItemInfo = cachedWorkItem || {
          id: embeddedWorkItem.id,
          identifier: embeddedWorkItem.identifier,
          title: embeddedWorkItem.title,
          type: embeddedWorkItem.type,
          project: project || { id: '', identifier: '', name: 'Unknown' },
        };

        const existing = workItemHours.get(workItem.id);
        if (existing) {
          existing.hours += hours;
        } else {
          workItemHours.set(workItem.id, { workItem, hours });
        }
      }
    }

    // 排序
    const byProject = Array.from(projectHours.values())
      .sort((a, b) => b.hours - a.hours)
      .map(({ project, hours }) => ({ project, hours }));

    const byWorkItem = Array.from(workItemHours.values())
      .sort((a, b) => b.hours - a.hours)
      .map(({ workItem, hours }) => ({ work_item: workItem, hours }));

    const byDay = Array.from(dayHours.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, hours]) => ({ date, hours }));

    const byWeek = Array.from(weekHours.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, hours]) => ({ week, hours }));

    const byMonth = Array.from(monthHours.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, hours]) => ({ month, hours }));

    const byType = Array.from(typeHours.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([type, hours]) => ({ type, hours }));

    return { totalHours, byProject, byWorkItem, byDay, byWeek, byMonth, byType };
  }

  /**
   * 构建工时明细
   */
  private buildDetails(
    workloads: PingCodeWorkload[],
    workItems: Map<string, WorkItemInfo>
  ): WorkloadDetail[] {
    return workloads
      .map(w => {
        let workItem: WorkItemInfo | null = null;
        if (w.work_item) {
          const cachedWorkItem = workItems.get(w.work_item.id);
          if (cachedWorkItem) {
            workItem = cachedWorkItem;
          } else {
            workItem = {
              id: w.work_item.id,
              identifier: w.work_item.identifier,
              title: w.work_item.title,
              type: w.work_item.type,
              project: { id: '', identifier: '', name: 'Unknown' },
            };
          }
        }
        return {
          date: formatTimestamp(w.report_at),
          workload_id: w.id,
          hours: w.duration,
          work_item: workItem,
          description: w.description,
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));  // 按日期倒序
  }

  /**
   * 按项目过滤工时
   */
  private filterByProject(
    workloadsMap: Map<string, WorkloadsResult>,
    workItems: Map<string, WorkItemInfo>,
    projectId: string
  ): Map<string, WorkloadsResult> {
    const filtered = new Map<string, WorkloadsResult>();

    for (const [userId, result] of workloadsMap) {
      // 通过 work_item 获取 project.id 进行过滤
      const filteredWorkloads = result.workloads.filter(w => {
        if (!w.work_item) return false;
        const workItem = workItems.get(w.work_item.id);
        return workItem?.project?.id === projectId;
      });

      filtered.set(userId, {
        ...result,
        workloads: filteredWorkloads,
        totalCount: filteredWorkloads.length,
      });
    }

    return filtered;
  }

  /**
   * 构建人天矩阵
   */
  private buildDayMatrix(
    workloadsMap: Map<string, WorkloadsResult>,
    usersMap: Map<string, UserInfo>,
    startAt: number,
    endAt: number
  ): { dates: string[]; rows: DayMatrixRow[] } {
    // 生成日期列表
    const dates: string[] = [];
    const current = new Date(startAt * 1000);
    const end = new Date(endAt * 1000);

    while (current < end) {
      dates.push(current.toISOString().split('T')[0]);
      current.setDate(current.getDate() + 1);
    }

    // 构建每个用户的行
    const rows: DayMatrixRow[] = [];

    for (const [userId, result] of workloadsMap) {
      const user = usersMap.get(userId);
      if (!user) continue;

      // 按日期汇总
      const dayMap = new Map<string, number>();
      for (const w of result.workloads) {
        const date = formatTimestamp(w.report_at);
        dayMap.set(date, (dayMap.get(date) || 0) + w.duration);
      }

      const hoursPerDay = dates.map(d => dayMap.get(d) || 0);

      // 只包含有工时的用户
      if (hoursPerDay.some(h => h > 0)) {
        rows.push({ user, hours_per_day: hoursPerDay });
      }
    }

    // 按总工时排序
    rows.sort((a, b) => {
      const totalA = a.hours_per_day.reduce((sum, h) => sum + h, 0);
      const totalB = b.hours_per_day.reduce((sum, h) => sum + h, 0);
      return totalB - totalA;
    });

    return { dates, rows };
  }

  /**
   * 获取周的 key (ISO week format: "2026-W05")
   */
  private getWeekKey(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    const year = date.getFullYear();

    // 计算 ISO 周数
    const jan1 = new Date(year, 0, 1);
    const days = Math.floor((date.getTime() - jan1.getTime()) / (24 * 60 * 60 * 1000));
    const weekNum = Math.ceil((days + jan1.getDay() + 1) / 7);

    return `${year}-W${weekNum.toString().padStart(2, '0')}`;
  }
}

// Singleton instance
export const workloadService = new WorkloadService();
