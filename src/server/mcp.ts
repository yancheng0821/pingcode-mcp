import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';
import {
  registerAllTools,
  toolRegistry,
  getBuiltinToolDefinitions,
  handleBuiltinTool,
} from '../tools/registry.js';

/**
 * 检测工具返回结果是否为业务错误（包含 error + code 字段）
 * 如 NO_DATA、USER_NOT_FOUND、AMBIGUOUS_USER、INTERNAL_ERROR 等
 */
export function isBusinessError(result: unknown): boolean {
  return (
    !!result &&
    typeof result === 'object' &&
    'error' in result &&
    'code' in result &&
    typeof (result as Record<string, unknown>).error === 'string' &&
    typeof (result as Record<string, unknown>).code === 'string'
  );
}

/**
 * 创建并配置 MCP Server（注册工具 + CallTool handler）
 *
 * 独立导出以供测试复用，避免测试复刻 handler 逻辑。
 */
export function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'pingcode-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // 注册所有工具
  registerAllTools();

  // Register list tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // 合并版本化工具和内置工具
    const versionedTools = toolRegistry.getToolDefinitions();
    const builtinTools = getBuiltinToolDefinitions();

    return {
      tools: [...versionedTools, ...builtinTools],
    };
  });

  // Register call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const startTime = Date.now();

    logger.info({ tool: name }, 'Tool called');

    try {
      // 先检查是否是内置工具
      const builtinResult = await handleBuiltinTool(name);
      if (builtinResult) {
        metrics.recordSuccess(`tool:${name}`, Date.now() - startTime);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(builtinResult.result, null, 2),
            },
          ],
        };
      }

      // 检查是否是版本化工具
      if (!toolRegistry.hasTools(name)) {
        metrics.recordError(`tool:${name}`, Date.now() - startTime);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `Unknown tool: ${name}` }),
            },
          ],
          isError: true,
        };
      }

      // 调用版本化工具
      const { result, warnings } = await toolRegistry.callTool(name, args);

      // 记录指标
      if (isBusinessError(result)) {
        metrics.recordError(`tool:${name}`, Date.now() - startTime);
      } else {
        metrics.recordSuccess(`tool:${name}`, Date.now() - startTime);
      }

      // 构建响应
      const response: { result: unknown; warnings?: string[] } = { result };
      if (warnings.length > 0) {
        response.warnings = warnings;
      }

      const payload = response.warnings ? response : result;
      const text = JSON.stringify(payload, null, 2);

      // 业务错误（NO_DATA / USER_NOT_FOUND 等）标记 isError，让 LLM 可自我纠错
      if (isBusinessError(result)) {
        return {
          content: [{ type: 'text', text }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text }],
      };
    } catch (error) {
      // 记录失败指标
      metrics.recordError(`tool:${name}`, Date.now() - startTime);

      logger.error({ error, tool: name }, 'Tool execution failed');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Tool execution failed',
              message: (error as Error).message,
            }),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}
