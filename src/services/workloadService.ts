import {
    listUserWorkloads,
    listWorkloadsForUsers,
    type WorkloadsResult,
} from '../api/endpoints/index.js';
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
    truncation_reasons?: string[];
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

export interface WeekMatrixRow {
    user: UserInfo;
    hours_per_week: number[];
}

export type MatrixType = 'day' | 'week';

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
    by_week_matrix?: {
        weeks: string[];
        rows: WeekMatrixRow[];
    };
    data_quality: {
        workloads_count: number;
        /** 工作项详情获取失败的数量（unique ID 粒度，项目作用域内精确值） */
        missing_work_item_count: number;
        unknown_user_matches: number;
        time_sliced: boolean;
        pagination_truncated: boolean;
        details_truncated: boolean;
        truncation_reasons?: string[];
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
            signal?: AbortSignal;
        } = {}
    ): Promise<UserWorkResult> {
        const { groupBy = 'work_item', topN = 10, signal } = options;

        // 1. 获取用户信息
        const user = await userService.getUser(userId, signal);
        if (!user) {
            throw new Error(`User not found: ${userId}`);
        }

        // 2. 获取工时数据
        const workloadsResult = await listUserWorkloads(userId, startAt, endAt, signal);
        const { workloads, timeSliced, paginationTruncated, truncationReasons } = workloadsResult;

        // 3. 获取工作项详情
        const { workItems, missingCount } = await workItemService.enrichWorkloadsWithWorkItems(workloads, signal);

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
                truncation_reasons: truncationReasons.length > 0 ? truncationReasons : undefined,
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
            matrixType?: MatrixType;
            includeZeroUsers?: boolean;
            signal?: AbortSignal;
        } = {}
    ): Promise<TeamWorkResult> {
        const { userIds, projectId, groupBy = 'user', topN = 5, includeMatrix = false, matrixType = 'day', includeZeroUsers = true, signal } = options;

        // 1. 获取用户列表
        let targetUserIds: string[];
        if (userIds && userIds.length > 0) {
            targetUserIds = userIds;
        } else {
            const allUsers = await userService.getAllUsers(signal);
            targetUserIds = allUsers.map(u => u.id);
        }

        // 2. 批量获取工时数据（projectId 由 API 服务端 pilot_id 过滤）
        const workloadsMap = await listWorkloadsForUsers(targetUserIds, startAt, endAt, { projectId, signal });

        // 3. 获取用户信息
        const usersMap = await userService.getUsersMap(targetUserIds, signal);

        // 4. 收集所有工时记录
        const allWorkloads: PingCodeWorkload[] = [];
        for (const result of workloadsMap.values()) {
            allWorkloads.push(...result.workloads);
        }

        // 5. 获取工作项详情
        const { workItems, missingCount } = await workItemService.enrichWorkloadsWithWorkItems(allWorkloads, signal);

        // 6. projectId 已在 API 层过滤（pilot_id），无需本地二次过滤。
        //    missingCount 即为目标项目作用域内的精确缺失数。
        const filteredWorkloadsMap = workloadsMap;
        const totalMissingWorkItemCount = missingCount;

        // 7. 聚合每个用户的数据
        const members: TeamMemberSummary[] = [];
        const allDetails: TeamWorkloadDetail[] = [];
        let totalHours = 0;
        let totalWorkloadsCount = 0;
        let anyTimeSliced = false;
        let anyPaginationTruncated = false;
        const allTruncationReasons = new Set<string>();

        // Track which users have been processed (for 0-hour user inclusion)
        const processedUserIds = new Set<string>();

        for (const [userId, result] of filteredWorkloadsMap) {
            const user = usersMap.get(userId);
            if (!user) continue;

            // Skip users with no workloads when includeZeroUsers is false
            if (!includeZeroUsers && result.workloads.length === 0) continue;

            processedUserIds.add(userId);

            const aggregated = this.aggregateWorkloads(result.workloads, workItems, groupBy as GroupBy, topN);

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
                            project: { id: null, identifier: null, name: 'Unknown' },
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
            if (result.truncationReasons) {
                for (const reason of result.truncationReasons) {
                    allTruncationReasons.add(reason);
                }
            }
        }

        // 包含 0 工时用户：usersMap 中存在但 workloadsMap 中无记录的用户
        if (includeZeroUsers) {
            for (const [userId, user] of usersMap) {
                if (processedUserIds.has(userId)) continue;
                const memberSummary: TeamMemberSummary = {
                    user,
                    total_hours: 0,
                };
                switch (groupBy) {
                    case 'day':
                        memberSummary.by_day = [];
                        break;
                    case 'week':
                        memberSummary.by_week = [];
                        break;
                    case 'month':
                        memberSummary.by_month = [];
                        break;
                    case 'project':
                        memberSummary.by_project = [];
                        break;
                    case 'work_item':
                        memberSummary.by_work_item = [];
                        break;
                    case 'type':
                        memberSummary.by_type = [];
                        break;
                    case 'user':
                    default:
                        memberSummary.top_projects = [];
                        memberSummary.top_work_items = [];
                        break;
                }
                members.push(memberSummary);
            }
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
                truncation_reasons: allTruncationReasons.size > 0 ? [...allTruncationReasons] : undefined,
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

        // 11. 构建矩阵（如果需要）
        if (includeMatrix) {
            if (matrixType === 'week') {
                teamResult.by_week_matrix = this.buildWeekMatrix(filteredWorkloadsMap, usersMap, startAt, endAt);
            } else {
                teamResult.by_day_matrix = this.buildDayMatrix(filteredWorkloadsMap, usersMap, startAt, endAt);
            }
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

            if (project && project.id) {
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
                    project: project || { id: null, identifier: null, name: 'Unknown' },
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
                            project: { id: null, identifier: null, name: 'Unknown' },
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
     * 构建人天矩阵
     */
    private buildDayMatrix(
        workloadsMap: Map<string, WorkloadsResult>,
        usersMap: Map<string, UserInfo>,
        startAt: number,
        endAt: number
    ): { dates: string[]; rows: DayMatrixRow[] } {
        // 生成日期列表（使用配置时区，与 formatTimestamp 一致）
        const dates: string[] = [];
        const DAY_SECONDS = 86400;
        for (let ts = startAt; ts < endAt; ts += DAY_SECONDS) {
            dates.push(formatTimestamp(ts));
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
     * 构建人周矩阵
     */
    private buildWeekMatrix(
        workloadsMap: Map<string, WorkloadsResult>,
        usersMap: Map<string, UserInfo>,
        startAt: number,
        endAt: number
    ): { weeks: string[]; rows: WeekMatrixRow[] } {
        // 生成周列表：收集范围内所有 ISO 周 key
        const weekSet = new Set<string>();
        const DAY_SECONDS = 86400;
        for (let ts = startAt; ts < endAt; ts += DAY_SECONDS) {
            weekSet.add(this.getWeekKey(ts));
        }
        const weeks = Array.from(weekSet).sort();

        // 构建 week→index 映射
        const weekIndex = new Map<string, number>();
        weeks.forEach((w, i) => weekIndex.set(w, i));

        // 构建每个用户的行
        const rows: WeekMatrixRow[] = [];

        for (const [userId, result] of workloadsMap) {
            const user = usersMap.get(userId);
            if (!user) continue;

            // 按周汇总
            const weekMap = new Map<string, number>();
            for (const w of result.workloads) {
                const week = this.getWeekKey(w.report_at);
                weekMap.set(week, (weekMap.get(week) || 0) + w.duration);
            }

            const hoursPerWeek = weeks.map(wk => weekMap.get(wk) || 0);

            // 只包含有工时的用户
            if (hoursPerWeek.some(h => h > 0)) {
                rows.push({ user, hours_per_week: hoursPerWeek });
            }
        }

        // 按总工时排序
        rows.sort((a, b) => {
            const totalA = a.hours_per_week.reduce((sum, h) => sum + h, 0);
            const totalB = b.hours_per_week.reduce((sum, h) => sum + h, 0);
            return totalB - totalA;
        });

        return { weeks, rows };
    }

    /**
     * 获取周的 key (ISO 8601 week format: "2026-W05")
     *
     * ISO 8601: Week 1 = the week containing the year's first Thursday.
     * The ISO year may differ from the calendar year at year boundaries.
     */
    private getWeekKey(timestamp: number): string {
        const date = new Date(timestamp * 1000);

        // Find the Thursday of the current week (ISO weeks start on Monday)
        const target = new Date(date.valueOf());
        target.setDate(target.getDate() - ((target.getDay() + 6) % 7) + 3);
        const firstThursday = target.valueOf();

        // Find the first Thursday of the ISO year
        target.setMonth(0, 1);
        if (target.getDay() !== 4) {
            target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
        }

        const weekNum = 1 + Math.ceil((firstThursday - target.valueOf()) / (7 * 24 * 60 * 60 * 1000));
        const year = new Date(firstThursday).getFullYear();

        return `${year}-W${weekNum.toString().padStart(2, '0')}`;
    }
}

// Singleton instance
export const workloadService = new WorkloadService();
