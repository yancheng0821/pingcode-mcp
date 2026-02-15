import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';
import { randomUUID } from 'node:crypto';
import { type UserContext } from '../auth/userContext.js';

// 解析允许的 Origin 列表（启动时计算一次）
const allowedOrigins = new Set(
  config.auth.allowedOrigins
    ? config.auth.allowedOrigins.split(',').map(s => s.trim()).filter(Boolean)
    : []
);

/**
 * 验证 Origin（防 DNS rebinding 攻击）
 * - 无 Origin 头（非浏览器请求）：放行
 * - 未配置 allowlist（空）+ 有 Origin：拒绝（default-deny）
 * - 配置了 allowlist 且 Origin 在列表中：放行
 * - 配置了 allowlist 且 Origin 不在列表中：拒绝
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (allowedOrigins.size === 0) return false;
  return allowedOrigins.has(origin);
}

/**
 * 设置 CORS 响应头
 */
export function setCorsHeaders(res: ServerResponse, origin: string | undefined): void {
  // 仅当 origin 在白名单中才设置 ACAO；否则不设置（浏览器会拦截）
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, Authorization, Mcp-Session-Id, X-API-Key, MCP-Protocol-Version');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

/**
 * Parse API keys from both MCP_API_KEY (legacy) and MCP_API_KEYS (multi-key).
 * MCP_API_KEYS format: "key1:id1,key2:id2" or just "key1,key2" (auto-generates ids)
 * Returns Map<key, keyId>
 */
function parseApiKeys(): Map<string, string> {
  const keys = new Map<string, string>();

  // Legacy single key
  if (config.auth.apiKey) {
    keys.set(config.auth.apiKey, 'default');
  }

  // Multi-key
  if (config.auth.apiKeys) {
    for (const entry of config.auth.apiKeys.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex > 0) {
        const key = trimmed.slice(0, colonIndex);
        const id = trimmed.slice(colonIndex + 1);
        keys.set(key, id);
      } else {
        // No id provided — use position-based id
        keys.set(trimmed, `key-${keys.size}`);
      }
    }
  }

  return keys;
}

// Parse once at module load
const apiKeyMap = parseApiKeys();

/**
 * 验证 API Key
 * 支持 Authorization: Bearer <key> 或 X-API-Key: <key>
 * Returns { valid, keyId } for audit logging.
 *
 * When TOKEN_MODE=user, keyId doubles as the bound userId — the API key
 * proves both "you can use this service" AND "you are this user", preventing
 * identity forgery via untrusted headers.
 */
export function validateApiKey(req: IncomingMessage): { valid: boolean; keyId?: string } {
  // 如果未配置任何 API Key，跳过验证
  if (apiKeyMap.size === 0) {
    return { valid: true };
  }

  const authHeader = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'] as string | undefined;

  // 检查 Authorization: Bearer <key>
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      const keyId = apiKeyMap.get(match[1]);
      if (keyId) return { valid: true, keyId };
    }
  }

  // 检查 X-API-Key: <key>
  if (apiKeyHeader) {
    const keyId = apiKeyMap.get(apiKeyHeader);
    if (keyId) return { valid: true, keyId };
  }

  return { valid: false };
}

// Export for testing
export { parseApiKeys, apiKeyMap };

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
 * Resolve the bound user ID from an API key's keyId.
 *
 * In TOKEN_MODE=user, the API key proves identity:
 * - MCP_API_KEYS="key1:user-alice,key2:user-bob" → keyId IS the userId
 * - Single MCP_API_KEY (keyId="default") → fall back to PINGCODE_USER_ID
 *
 * Returns undefined if no user can be resolved (caller should reject).
 */
export function resolveBoundUserId(keyId: string | undefined): string | undefined {
  if (!keyId) return undefined;

  // Single-key mode: keyId is "default", use PINGCODE_USER_ID
  if (keyId === 'default') {
    return config.pingcode.userId || undefined;
  }

  // Auto-generated key IDs (e.g., "key-0") without explicit user binding
  if (keyId.startsWith('key-')) {
    return config.pingcode.userId || undefined;
  }

  // Multi-key mode: keyId IS the userId
  return keyId;
}

/**
 * 启动 HTTP/SSE 模式的 MCP Server
 */
const MAX_SESSIONS = config.server.httpMaxSessions;
const SESSION_TTL_MS = config.server.httpSessionTtlMs;
const SESSION_CLEANUP_INTERVAL_MS = Math.min(60_000, Math.max(1_000, Math.floor(SESSION_TTL_MS / 2)));

export async function startHttpServer(serverFactory: (ctx?: UserContext) => Server): Promise<void> {
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

    // API Key 验证（以下端点均需鉴权，包括 /metrics）
    const authResult = validateApiKey(req);
    if (!authResult.valid) {
      const clientIp = getClientIp(req);
      logger.warn({ clientIp, path }, 'Unauthorized request');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing API key' }));
      return;
    }
    if (authResult.keyId) {
      logger.debug({ keyId: authResult.keyId, path }, 'Authenticated request');
    }

    // 指标端点（需要鉴权，防止暴露运行态信息）
    if (path === '/metrics' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metrics.getSnapshot(), null, 2));
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
      } catch (parseError) {
        if (parseError instanceof PayloadTooLargeError) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload Too Large', message: parseError.message }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bad Request', message: 'Invalid JSON' }));
        }
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

          // Build UserContext for user-mode sessions.
          // Identity is derived from the API key binding — NOT from
          // client-supplied headers — to prevent identity forgery.
          //
          // MCP_API_KEYS format in user mode: "key1:userId1,key2:userId2"
          // Single MCP_API_KEY: uses PINGCODE_USER_ID as the bound user.
          let sessionUserContext: UserContext | undefined;
          if (config.pingcode.tokenMode === 'user') {
            // Warn if client sends X-User-Id (ignored for security)
            if (req.headers['x-user-id']) {
              logger.warn('X-User-Id header is ignored in TOKEN_MODE=user; identity is derived from API key binding');
            }

            const boundUserId = resolveBoundUserId(authResult.keyId);
            if (!boundUserId) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: 'USER_IDENTITY_NOT_BOUND',
                message: 'TOKEN_MODE=user requires each API key to be bound to a user ID. '
                  + 'Use MCP_API_KEYS=key:userId format, or set PINGCODE_USER_ID for single-key mode.',
              }));
              return;
            }
            sessionUserContext = { userId: boundUserId, tokenMode: 'user' };
          }

          // 为新 session 创建独立的 MCP Server（SDK 要求每个 transport 对应一个 Server 实例）
          const sessionServer = serverFactory(sessionUserContext);
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
 * 解析请求体（带大小限制，防止 OOM）
 */
const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1 MB

async function parseRequestBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // GET 请求没有 body
    if (req.method === 'GET') {
      resolve(undefined);
      return;
    }

    // Fast-path: reject if Content-Length exceeds limit
    const contentLength = req.headers['content-length'];
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
      req.resume(); // drain the stream
      reject(new PayloadTooLargeError());
      return;
    }

    const chunks: Buffer[] = [];
    let totalSize = 0;

    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new PayloadTooLargeError());
        return;
      }
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

class PayloadTooLargeError extends Error {
  constructor() {
    super(`Request body exceeds ${MAX_BODY_SIZE} bytes`);
    this.name = 'PayloadTooLargeError';
  }
}
