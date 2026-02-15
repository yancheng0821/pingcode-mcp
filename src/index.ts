import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { cache } from './cache/index.js';
import { startHttpServer } from './server/http.js';
import { createMcpServer } from './server/mcp.js';

async function main() {
  // HTTP 模式强制要求 API Key
  if (config.server.transportMode === 'http' && !config.auth.apiKey) {
    console.error('Error: MCP_API_KEY is required for HTTP mode');
    console.error('Please set MCP_API_KEY environment variable or use stdio mode');
    process.exit(1);
  }

  // TOKEN_MODE=user 尚未实现，给出明确警告
  if (config.pingcode.tokenMode === 'user') {
    logger.warn('TOKEN_MODE=user is not yet supported; falling back to enterprise token behavior');
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
    // stdio 模式：本地进程通信，单 Server + 单 Transport
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('MCP Server running on stdio');
  } else {
    // HTTP 模式：网络服务，每个 session 创建独立 Server（SDK 要求）
    await startHttpServer(createMcpServer);
  }
}

main().catch((error) => {
  logger.error({ error }, 'Fatal error');
  process.exit(1);
});
