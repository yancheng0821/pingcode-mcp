/**
 * 工具版本管理模块
 *
 * 支持：
 * - 多版本工具并存（v1, v2, ...）
 * - 版本别名（user_work_summary → user_work_summary_v1）
 * - 版本废弃警告
 * - 平滑升级路径
 */

import { z } from 'zod';
import { logger } from '../utils/logger.js';

// 版本状态
export type VersionStatus = 'current' | 'supported' | 'deprecated' | 'removed';

// 工具版本信息
export interface ToolVersion {
  version: string;
  status: VersionStatus;
  deprecatedAt?: string;      // ISO 日期，何时标记废弃
  removalDate?: string;       // ISO 日期，计划移除日期
  migrationGuide?: string;    // 升级指南
  handler: (input: unknown, signal?: AbortSignal) => Promise<unknown>;
  inputSchema: z.ZodTypeAny;
  definition: ToolDefinition;
}

// MCP 工具定义
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

// 版本化工具
export interface VersionedTool {
  baseName: string;
  currentVersion: string;
  versions: Map<string, ToolVersion>;
}

/**
 * 工具版本注册表
 */
class ToolRegistry {
  private tools = new Map<string, VersionedTool>();

  /**
   * 注册工具版本
   */
  register(
    baseName: string,
    version: string,
    config: {
      status: VersionStatus;
      deprecatedAt?: string;
      removalDate?: string;
      migrationGuide?: string;
      handler: (input: unknown, signal?: AbortSignal) => Promise<unknown>;
      inputSchema: z.ZodTypeAny;
      definition: Omit<ToolDefinition, 'name'>;
    }
  ): void {
    let tool = this.tools.get(baseName);
    if (!tool) {
      tool = {
        baseName,
        currentVersion: version,
        versions: new Map(),
      };
      this.tools.set(baseName, tool);
    }

    // 更新 current 版本
    if (config.status === 'current') {
      tool.currentVersion = version;
    }

    const versionedName = `${baseName}_${version}`;
    const toolVersion: ToolVersion = {
      version,
      status: config.status,
      deprecatedAt: config.deprecatedAt,
      removalDate: config.removalDate,
      migrationGuide: config.migrationGuide,
      handler: config.handler,
      inputSchema: config.inputSchema,
      definition: {
        ...config.definition,
        name: versionedName,
        description: this.buildDescription(config.definition.description, version, config),
      },
    };

    tool.versions.set(version, toolVersion);

    logger.debug({ baseName, version, status: config.status }, 'Tool version registered');
  }

  /**
   * 构建带版本信息的描述
   */
  private buildDescription(
    baseDescription: string,
    version: string,
    config: { status: VersionStatus; deprecatedAt?: string; removalDate?: string; migrationGuide?: string }
  ): string {
    const lines = [baseDescription, '', `[Version: ${version}]`];

    if (config.status === 'deprecated') {
      lines.push('');
      lines.push('⚠️ DEPRECATED: This version is deprecated.');
      if (config.removalDate) {
        lines.push(`   Will be removed after: ${config.removalDate}`);
      }
      if (config.migrationGuide) {
        lines.push(`   Migration: ${config.migrationGuide}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 获取所有工具定义（用于 ListTools）
   */
  getToolDefinitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];

    for (const tool of this.tools.values()) {
      // 添加别名（baseName 指向 current 版本）
      const currentVersion = tool.versions.get(tool.currentVersion);
      if (currentVersion) {
        definitions.push({
          ...currentVersion.definition,
          name: tool.baseName,  // 不带版本号的别名
          description: currentVersion.definition.description.replace(
            `[Version: ${tool.currentVersion}]`,
            `[Version: ${tool.currentVersion}] (alias: ${tool.baseName}_${tool.currentVersion})`
          ),
        });
      }

      // 添加所有显式版本
      for (const [, toolVersion] of tool.versions) {
        // 跳过已移除的版本
        if (toolVersion.status === 'removed') continue;

        definitions.push(toolVersion.definition);
      }
    }

    return definitions;
  }

  /**
   * 调用工具（支持别名和显式版本）
   */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<{ result: unknown; warnings: string[] }> {
    const warnings: string[] = [];

    // 解析工具名和版本
    const { baseName, version } = this.parseToolName(name);

    const tool = this.tools.get(baseName);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    // 确定要调用的版本
    const targetVersion = version || tool.currentVersion;
    const toolVersion = tool.versions.get(targetVersion);

    if (!toolVersion) {
      throw new Error(`Unknown version ${targetVersion} for tool ${baseName}`);
    }

    if (toolVersion.status === 'removed') {
      throw new Error(`Tool ${name} has been removed. ${toolVersion.migrationGuide || ''}`);
    }

    // 废弃警告
    if (toolVersion.status === 'deprecated') {
      const warning = `Tool ${name} is deprecated` +
        (toolVersion.removalDate ? ` and will be removed after ${toolVersion.removalDate}` : '') +
        (toolVersion.migrationGuide ? `. Migration: ${toolVersion.migrationGuide}` : '');
      warnings.push(warning);
      logger.warn({ tool: name, version: targetVersion }, 'Deprecated tool called');
    }

    // 验证输入
    const parsed = toolVersion.inputSchema.parse(args);

    // 调用处理器
    const result = await toolVersion.handler(parsed, signal);

    return { result, warnings };
  }

  /**
   * 解析工具名，提取 baseName 和 version
   * user_work_summary -> { baseName: 'user_work_summary', version: undefined }
   * user_work_summary_v1 -> { baseName: 'user_work_summary', version: 'v1' }
   */
  private parseToolName(name: string): { baseName: string; version?: string } {
    // 检查是否是已知的 baseName（别名）
    if (this.tools.has(name)) {
      return { baseName: name };
    }

    // 尝试解析 baseName_version 格式
    const match = name.match(/^(.+)_(v\d+)$/);
    if (match) {
      const [, baseName, version] = match;
      if (this.tools.has(baseName)) {
        return { baseName, version };
      }
    }

    // 未知工具
    return { baseName: name };
  }

  /**
   * 检查工具是否存在
   */
  hasTools(name: string): boolean {
    const { baseName } = this.parseToolName(name);
    return this.tools.has(baseName);
  }

  /**
   * 获取工具版本信息（用于调试）
   */
  getVersionInfo(): Record<string, { current: string; versions: string[] }> {
    const info: Record<string, { current: string; versions: string[] }> = {};

    for (const [baseName, tool] of this.tools) {
      info[baseName] = {
        current: tool.currentVersion,
        versions: Array.from(tool.versions.keys()),
      };
    }

    return info;
  }
}

// Singleton instance
export const toolRegistry = new ToolRegistry();
