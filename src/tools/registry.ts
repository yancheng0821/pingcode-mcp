/**
 * 工具注册入口
 *
 * 在此注册所有工具的所有版本
 */

import { toolRegistry } from './versions.js';

// 导入工具实现
import {
  userWorkSummary,
  userWorkSummaryToolDefinition,
  UserWorkSummaryInputSchema,
} from './userWorkSummary.js';

import {
  teamWorkSummary,
  teamWorkSummaryToolDefinition,
  TeamWorkSummaryInputSchema,
} from './teamWorkSummary.js';

import {
  listUsers,
  listUsersToolDefinition,
  ListUsersInputSchema,
} from './listUsers.js';

import {
  listWorkloads,
  listWorkloadsToolDefinition,
  ListWorkloadsInputSchema,
} from './listWorkloads.js';

import {
  getWorkItem,
  getWorkItemToolDefinition,
  GetWorkItemInputSchema,
} from './getWorkItem.js';

import { metrics } from '../utils/metrics.js';

/**
 * 注册所有工具
 */
export function registerAllTools(): void {
  // ============ user_work_summary ============
  toolRegistry.register('user_work_summary', 'v1', {
    status: 'current',
    handler: userWorkSummary as (input: unknown) => Promise<unknown>,
    inputSchema: UserWorkSummaryInputSchema,
    definition: userWorkSummaryToolDefinition,
  });

  // 示例：如果有 v2 版本
  // toolRegistry.register('user_work_summary', 'v2', {
  //   status: 'current',  // v2 成为 current
  //   handler: userWorkSummaryV2 as (input: unknown) => Promise<unknown>,
  //   inputSchema: UserWorkSummaryV2InputSchema,
  //   definition: userWorkSummaryV2ToolDefinition,
  // });
  // 同时将 v1 标记为 deprecated
  // toolRegistry.register('user_work_summary', 'v1', {
  //   status: 'deprecated',
  //   deprecatedAt: '2026-03-01',
  //   removalDate: '2026-06-01',
  //   migrationGuide: 'Use user_work_summary_v2. New fields: xxx',
  //   handler: userWorkSummary as (input: unknown) => Promise<unknown>,
  //   inputSchema: UserWorkSummaryInputSchema,
  //   definition: userWorkSummaryToolDefinition,
  // });

  // ============ team_work_summary ============
  toolRegistry.register('team_work_summary', 'v1', {
    status: 'current',
    handler: teamWorkSummary as (input: unknown) => Promise<unknown>,
    inputSchema: TeamWorkSummaryInputSchema,
    definition: teamWorkSummaryToolDefinition,
  });

  // ============ list_users ============
  toolRegistry.register('list_users', 'v1', {
    status: 'current',
    handler: listUsers as (input: unknown) => Promise<unknown>,
    inputSchema: ListUsersInputSchema,
    definition: listUsersToolDefinition,
  });

  // ============ list_workloads ============
  toolRegistry.register('list_workloads', 'v1', {
    status: 'current',
    handler: listWorkloads as (input: unknown) => Promise<unknown>,
    inputSchema: ListWorkloadsInputSchema,
    definition: listWorkloadsToolDefinition,
  });

  // ============ get_work_item ============
  toolRegistry.register('get_work_item', 'v1', {
    status: 'current',
    handler: getWorkItem as (input: unknown) => Promise<unknown>,
    inputSchema: GetWorkItemInputSchema,
    definition: getWorkItemToolDefinition,
  });
}

/**
 * 获取内置工具定义（不通过版本系统）
 */
export function getBuiltinToolDefinitions(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return [
    {
      name: 'get_metrics',
      description: `获取服务运行指标。

返回：
- uptime_seconds: 服务运行时间
- requests: 请求统计（总量、错误数、错误率、按端点分类）
- cache: 缓存统计（命中数、未命中数、命中率）
- time_slicing: 时间分片统计

[Version: v1] (builtin)`,
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_tool_versions',
      description: `获取所有工具的版本信息。

返回每个工具的当前版本和所有可用版本列表。
用于调试和版本兼容性检查。

[Version: v1] (builtin)`,
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];
}

/**
 * 处理内置工具调用
 */
export async function handleBuiltinTool(name: string): Promise<{ result: unknown } | null> {
  switch (name) {
    case 'get_metrics':
      return { result: metrics.getSnapshot() };

    case 'get_tool_versions':
      return { result: toolRegistry.getVersionInfo() };

    default:
      return null;
  }
}

// 导出 registry
export { toolRegistry };
