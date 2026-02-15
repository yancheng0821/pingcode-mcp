import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';
import { randomUUID } from 'node:crypto';

// 解析允许的 Origin 列表（启动时计算一次）
const allowedOrigins = new Set(
  config.auth.allowedOrigins
    ? config.auth.allowedOrigins.split(',').map(s => s.trim()).filter(Boolean)
    : []
);

/**
 * 验证 Origin（防 DNS rebinding 攻击）
 * - 无 Origin 头（非浏览器请求）：放行
 * - 配置了 allowlist 且 Origin 不在列表中：拒绝
 * - 未配置 allowlist：放行（向后兼容）
 */
function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (allowedOrigins.size === 0) return true;
  return allowedOrigins.has(origin);
}

/**
 * 设置 CORS 响应头
 */
function setCorsHeaders(res: ServerResponse, origin: string | undefined): void {
  // 根据 allowlist 决定 Access-Control-Allow-Origin
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (allowedOrigins.size === 0) {
    // 未配置 allowlist 时保持开放（向后兼容，建议生产环境配置）
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  // 配置了 allowlist 但 origin 不匹配时不设置 Allow-Origin（浏览器会拦截）

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, Authorization, Mcp-Session-Id, X-API-Key, MCP-Protocol-Version');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

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
const MAX_SESSIONS = config.server.httpMaxSessions;
const SESSION_TTL_MS = config.server.httpSessionTtlMs;
const SESSION_CLEANUP_INTERVAL_MS = Math.min(60_000, Math.max(1_000, Math.floor(SESSION_TTL_MS / 2)));

export async function startHttpServer(serverFactory: () => Server): Promise<void> {
  // 存储活跃的 transport 实例（按 session ID）
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessionLastActive = new Map<string, number>();

  // 定期清理过期 session
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, lastActive] of sessionLastActive) {
      if (now - lastActive > SESSION_TTL_MS) {
        const transport = transports.get(id);
        if (transport) {
          transport.close();
        }
        transports.delete(id);
        sessionLastActive.delete(id);
        logger.info({ sessionId: id, idleMs: now - lastActive }, 'Session expired by TTL');
      }
    }
  }, SESSION_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref(); // 不阻止进程退出

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const httpRequestId = randomUUID();
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;
    const origin = req.headers['origin'] as string | undefined;

    logger.debug({ requestId: httpRequestId, method: req.method, path }, 'HTTP request received');

    // Origin 校验（防 DNS rebinding）
    if (!isOriginAllowed(origin)) {
      logger.warn({ origin, path }, 'Blocked request with invalid Origin');
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden', message: 'Invalid Origin' }));
      return;
    }

    // CORS 头
    setCorsHeaders(res, origin);

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

    // MCP 端点 - DELETE（终止 session）
    if (path === '/mcp' && req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        transport.close();
        transports.delete(sessionId);
        sessionLastActive.delete(sessionId);
        logger.info({ sessionId }, 'Session terminated by client');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
      }
      return;
    }

    // MCP 端点 - POST/GET
    if (path === '/mcp') {
      // 解析请求体
      let body: unknown;
      try {
        body = await parseRequestBody(req);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad Request', message: 'Invalid JSON' }));
        return;
      }

      try {
        // 获取或创建 session
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        let transport: StreamableHTTPServerTransport;
        let isNewSession = false;

        if (sessionId && transports.has(sessionId)) {
          // 复用已有的 transport — 续期
          transport = transports.get(sessionId)!;
          sessionLastActive.set(sessionId, Date.now());
        } else {
          // 容量检查
          if (transports.size >= MAX_SESSIONS) {
            logger.warn({ current: transports.size, max: MAX_SESSIONS }, 'Session limit reached');
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Service Unavailable', message: 'Too many active sessions' }));
            return;
          }

          // 创建新的 transport
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
          });

          // 为新 session 创建独立的 MCP Server（SDK 要求每个 transport 对应一个 Server 实例）
          const sessionServer = serverFactory();
          await sessionServer.connect(transport);

          // 清理关闭的连接
          transport.onclose = () => {
            if (transport.sessionId) {
              transports.delete(transport.sessionId);
              sessionLastActive.delete(transport.sessionId);
              logger.info({ sessionId: transport.sessionId }, 'Session closed');
            }
          };

          isNewSession = true;
        }

        // 处理请求（initialize 消息会在此期间分配 sessionId）
        await transport.handleRequest(req, res, body);

        // 新 session 在 handleRequest 之后才有 sessionId，此时存储
        if (isNewSession && transport.sessionId) {
          transports.set(transport.sessionId, transport);
          sessionLastActive.set(transport.sessionId, Date.now());
          logger.info({ sessionId: transport.sessionId }, 'New MCP session created');
        }
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

  // 启动服务器（默认 127.0.0.1，可通过 HTTP_HOST 配置暴露）
  const port = config.server.httpPort;
  const host = config.auth.httpHost || '127.0.0.1';
  httpServer.listen(port, host, () => {
    logger.info({ port, host }, 'MCP HTTP Server running');
  });

  // 优雅关闭
  const shutdown = () => {
    logger.info('Shutting down HTTP server...');

    clearInterval(cleanupTimer);

    // 关闭所有 transport
    for (const transport of transports.values()) {
      transport.close();
    }
    transports.clear();
    sessionLastActive.clear();

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
        reject(new SyntaxError('Invalid JSON in request body'));
      }
    });

    req.on('error', reject);
  });
}
