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
