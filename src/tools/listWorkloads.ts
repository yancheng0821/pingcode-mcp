import { z } from 'zod';
import { listWorkloads as apiListWorkloads } from '../api/endpoints/workloads.js';
import { userService } from '../services/index.js';
import { workItemService } from '../services/index.js';
import { parseTimeRange } from '../utils/timeUtils.js';
import { formatTimestamp } from '../utils/timeUtils.js';
import { logger } from '../utils/logger.js';
import { createToolDefinition } from './schemaUtils.js';

// ============ 常量 ============

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

// ============ Schema 定义 ============

export const ListWorkloadsInputSchema = z.object({
    // PRD 参数：principal_type + principal_id（统一查询入口）
    // - user: 按用户查询（转换为 report_by_id）
    // - project: 按项目查询（转换为 pilot_id）
    // - work_item: 按工作项查询（使用 API 原生 principal_type + principal_id）
    principal_type: z.enum(['user', 'project', 'work_item']).optional(),
    principal_id: z.string().optional(),
    // 兼容参数：直接使用 report_by_id（按填报人查询）
    report_by_id: z.string().optional(),
    // 时间范围
    time_range: z.object({
        start: z.string(),
        end: z.string(),
    }),
    // 兼容参数：用户对象（支持模糊匹配）
    user: z.object({
        id: z.string().optional(),
        name: z.string().optional(),
    }).optional(),
    // 本地过滤参数
    filter_project_id: z.string().optional(),
    filter_work_item_id: z.string().optional(),
    limit: z.number().optional().default(DEFAULT_LIMIT),
});

export type ListWorkloadsInput = z.infer<typeof ListWorkloadsInputSchema>;

// ============ 输出类型 ============

export interface WorkloadRecord {
    // 标准化字段
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
        project: { id: string | null; name: string } | null;
    } | null;
    project: {
        id: string | null;
        identifier: string | null;
        name: string;
    } | null;
    description?: string;
    // 原始字段
    user_id: string;
    project_id: string | null;
    work_item_id?: string;
    date_at: number;
    type?: string;
    created_at: number;
}

export interface ListWorkloadsOutput {
    workloads: WorkloadRecord[];
    total: number;
    returned: number;
    data_quality: {
        time_sliced: boolean;
        pagination_truncated: boolean;
        result_truncated: boolean;
        truncation_reasons?: string[];
    };
}

export interface ListWorkloadsError {
    error: string;
    code: 'INVALID_TIME_RANGE' | 'INVALID_PARAMS' | 'USER_NOT_FOUND' | 'AMBIGUOUS_USER' | 'NO_DATA' | 'INTERNAL_ERROR';
    candidates?: Array<{ id: string; name: string; display_name: string }>;
}

export type ListWorkloadsResult = ListWorkloadsOutput | ListWorkloadsError;

// ============ Tool 实现 ============

export async function listWorkloads(input: ListWorkloadsInput, signal?: AbortSignal): Promise<ListWorkloadsResult> {
    logger.info({ input }, 'list_workloads called');

    try {
        // 验证 principal_type 和 principal_id 必须同时提供
        if ((input.principal_type && !input.principal_id) || (!input.principal_type && input.principal_id)) {
            return {
                error: 'principal_type and principal_id must be provided together',
                code: 'INVALID_PARAMS',
            };
        }

        // 1. 处理 PRD 中的 principal_type 语义转换
        let filterUserId: string | undefined = input.report_by_id;
        let filterProjectId: string | undefined = input.filter_project_id;
        let apiPrincipalType: 'work_item' | undefined;
        let apiPrincipalId: string | undefined;

        if (input.principal_type && input.principal_id) {
            switch (input.principal_type) {
                case 'user':
                    // principal_type=user → 转换为 report_by_id 过滤
                    filterUserId = input.principal_id;
                    break;
                case 'project':
                    // principal_type=project → 转换为 pilot_id 过滤
                    filterProjectId = input.principal_id;
                    break;
                case 'work_item':
                    // principal_type=work_item → 使用 API 原生参数
                    apiPrincipalType = 'work_item';
                    apiPrincipalId = input.principal_id;
                    break;
            }
        }

        // 2. 解析用户参数（兼容旧的 user 对象方式）
        if (!filterUserId && input.user) {
            if (input.user.id) {
                filterUserId = input.user.id;
                const user = await userService.getUser(filterUserId, signal);
                if (!user) {
                    return {
                        error: `User not found: ${filterUserId}`,
                        code: 'USER_NOT_FOUND',
                    };
                }
            } else if (input.user.name) {
                const resolved = await userService.resolveUser({ name: input.user.name }, signal);
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

        // 3. 解析时间范围
        let timeRange;
        try {
            timeRange = parseTimeRange(input.time_range.start, input.time_range.end);
        } catch (error) {
            return {
                error: `Invalid time range: ${(error as Error).message}`,
                code: 'INVALID_TIME_RANGE',
            };
        }

        // 4. 获取工时数据
        const result = await apiListWorkloads({
            startAt: timeRange.start,
            endAt: timeRange.end,
            userId: filterUserId,
            projectId: filterProjectId,
            principalType: apiPrincipalType,
            principalId: apiPrincipalId,
            signal,
        });

        // 5. 获取工作项详情（可选增强）
        const { workItems } = await workItemService.enrichWorkloadsWithWorkItems(result.workloads, signal);

        // 6. 过滤
        let workloads = result.workloads;

        // 按工作项过滤（本地）
        if (input.filter_work_item_id) {
            workloads = workloads.filter(w => w.work_item?.id === input.filter_work_item_id);
        }

        // 7. 检查是否有数据
        if (workloads.length === 0) {
            const startDate = new Date(timeRange.start * 1000).toISOString().split('T')[0];
            const endDate = new Date(timeRange.end * 1000).toISOString().split('T')[0];
            return {
                error: `在 ${startDate} 至 ${endDate} 期间没有找到工时记录。`,
                code: 'NO_DATA',
            };
        }

        // 8. 应用硬上限
        const total = workloads.length;
        const effectiveLimit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
        const resultTruncated = workloads.length > effectiveLimit;
        workloads = workloads.slice(0, effectiveLimit);

        // 9. 格式化输出
        const formattedWorkloads: WorkloadRecord[] = workloads.map(w => {
            // 获取工作项详情（优先使用缓存的详细信息）
            let workItem = null;
            let projectInfo: { id: string | null; identifier?: string | null; name: string } | null = null;

            if (w.work_item) {
                const cachedWorkItem = workItems.get(w.work_item.id);
                if (cachedWorkItem) {
                    projectInfo = cachedWorkItem.project;
                    workItem = {
                        id: w.work_item.id,
                        identifier: w.work_item.identifier,
                        title: cachedWorkItem.title,
                        project: {
                            id: cachedWorkItem.project.id,
                            name: cachedWorkItem.project.name,
                        },
                    };
                } else {
                    workItem = {
                        id: w.work_item.id,
                        identifier: w.work_item.identifier,
                        title: w.work_item.title,
                        project: null,
                    };
                }
            }

            return {
                // 标准化字段
                id: w.id,
                date: formatTimestamp(w.report_at),
                hours: w.duration,
                user: {
                    id: w.report_by.id,
                    name: w.report_by.name,
                    display_name: w.report_by.display_name,
                },
                work_item: workItem,
                project: projectInfo ? {
                    id: projectInfo.id,
                    identifier: projectInfo.identifier ?? null,
                    name: projectInfo.name,
                } : null,
                description: w.description,
                // 原始字段
                user_id: w.report_by.id,
                project_id: projectInfo?.id ?? null,
                work_item_id: w.work_item?.id,
                date_at: w.report_at,
                type: w.type,
                created_at: w.created_at,
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
                truncation_reasons: result.truncationReasons.length > 0 ? result.truncationReasons : undefined,
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
    ...createToolDefinition(
        `获取工时记录列表。

支持多种过滤方式（按 PRD 定义）：
- 按用户查询：principal_type=user + principal_id=用户ID
- 按项目查询：principal_type=project + principal_id=项目ID
- 按工作项查询：principal_type=work_item + principal_id=工作项ID
- 按填报人查询：report_by_id 或 user（兼容方式）
- 按工作项过滤：filter_work_item_id（本地过滤）

返回：
- workloads: 工时记录列表（含用户、工作项、项目详情）
- total: 匹配的总数
- returned: 本次返回数量
- data_quality: 数据质量指标`,
        ListWorkloadsInputSchema,
    ),
};
