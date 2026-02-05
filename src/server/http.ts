import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';
import { randomUUID } from 'node:crypto';

/**
 * 验证 API Key
 * 支持 Authorization: Bearer <key> 或 X-API-Key: <key>
 */
function validateApiKey(req: IncomingMessage): boolean {
  // 如果未配置 API Key，跳过验证
  if (!config.auth.apiKey) {
    return true;
  }

  const authHeader = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'];

  // 检查 Authorization: Bearer <key>
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1] === config.auth.apiKey) {
      return true;
    }
  }

  // 检查 X-API-Key: <key>
  if (apiKeyHeader === config.auth.apiKey) {
    return true;
  }

  return false;
}

/**
 * 获取客户端 IP（支持反向代理）
 */
function getClientIp(req: IncomingMessage): string {
  if (config.auth.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
      return ips.trim();
    }
    const realIp = req.headers['x-real-ip'];
    if (realIp) {
      return Array.isArray(realIp) ? realIp[0] : realIp;
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * 启动 HTTP/SSE 模式的 MCP Server
 */
export async function startHttpServer(mcpServer: Server): Promise<void> {
  // 存储活跃的 transport 实例（按 session ID）
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;

    // CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

    // 处理 OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 健康检查端点（不需要鉴权）
    if (path === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'pingcode-mcp' }));
      return;
    }

    // 指标端点（不需要鉴权，供 Prometheus 等监控系统抓取）
    if (path === '/metrics' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metrics.getSnapshot(), null, 2));
      return;
    }

    // API Key 验证（以下端点需要鉴权）
    if (!validateApiKey(req)) {
      const clientIp = getClientIp(req);
      logger.warn({ clientIp, path }, 'Unauthorized request');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing API key' }));
      return;
    }

    // MCP 端点
    if (path === '/mcp') {
      try {
        // 获取或创建 session
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports.has(sessionId)) {
          // 复用已有的 transport
          transport = transports.get(sessionId)!;
        } else {
          // 创建新的 transport
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
          });

          // 连接到 MCP Server
          await mcpServer.connect(transport);

          // 存储 transport
          if (transport.sessionId) {
            transports.set(transport.sessionId, transport);

            // 清理关闭的连接
            transport.onclose = () => {
              if (transport.sessionId) {
                transports.delete(transport.sessionId);
                logger.info({ sessionId: transport.sessionId }, 'Session closed');
              }
            };
          }

          logger.info({ sessionId: transport.sessionId }, 'New MCP session created');
        }

        // 解析请求体
        const body = await parseRequestBody(req);

        // 处理请求
        await transport.handleRequest(req, res, body);
      } catch (error) {
        logger.error({ error, path, method: req.method }, 'MCP request error');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
      return;
    }

    // 404 - 未找到
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // 启动服务器
  const port = config.server.httpPort;
  httpServer.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'MCP HTTP Server running');
    console.log(`MCP Server listening on http://0.0.0.0:${port}/mcp`);
  });

  // 优雅关闭
  const shutdown = () => {
    logger.info('Shutting down HTTP server...');

    // 关闭所有 transport
    for (const transport of transports.values()) {
      transport.close();
    }
    transports.clear();

    httpServer.close(() => {
      logger.info('HTTP server closed');
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * 解析请求体
 */
async function parseRequestBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // GET 请求没有 body
    if (req.method === 'GET') {
      resolve(undefined);
      return;
    }

    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }

      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(JSON.parse(body));
      } catch {
        resolve(undefined);
      }
    });

    req.on('error', reject);
  });
}
