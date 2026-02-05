import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { cache } from './cache/index.js';
import { metrics } from './utils/metrics.js';
import { startHttpServer } from './server/http.js';
import {
  registerAllTools,
  toolRegistry,
  getBuiltinToolDefinitions,
  handleBuiltinTool,
} from './tools/registry.js';

/**
 * 创建并配置 MCP Server
 */
function createMcpServer(): Server {
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

      // 记录成功指标
      metrics.recordSuccess(`tool:${name}`, Date.now() - startTime);

      // 构建响应
      const response: { result: unknown; warnings?: string[] } = { result };
      if (warnings.length > 0) {
        response.warnings = warnings;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.warnings ? response : result, null, 2),
          },
        ],
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

async function main() {
  // HTTP 模式强制要求 API Key
  if (config.server.transportMode === 'http' && !config.auth.apiKey) {
    console.error('Error: MCP_API_KEY is required for HTTP mode');
    console.error('Please set MCP_API_KEY environment variable or use stdio mode');
    process.exit(1);
  }

  logger.info({
    transportMode: config.server.transportMode,
    timezone: config.timezone,
    authEnabled: !!config.auth.apiKey,
  }, 'Starting PingCode MCP Server');

  // Connect to cache
  try {
    await cache.connect();
  } catch (error) {
    logger.error({ error }, 'Failed to connect to cache, continuing without cache');
  }

  // Create MCP server
  const server = createMcpServer();

  // Handle shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    await cache.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Shutting down...');
    await cache.disconnect();
    process.exit(0);
  });

  // Start server based on transport mode
  if (config.server.transportMode === 'stdio') {
    // stdio 模式：本地进程通信
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('MCP Server running on stdio');
  } else {
    // HTTP 模式：网络服务
    await startHttpServer(server);
  }
}

main().catch((error) => {
  logger.error({ error }, 'Fatal error');
  process.exit(1);
});
