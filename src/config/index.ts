import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  // PingCode API
  pingcode: z.object({
    baseUrl: z.string().url().default('https://open.pingcode.com'),
    token: z.string().min(1, 'PINGCODE_TOKEN is required'),
    tokenMode: z.enum(['enterprise', 'user']).default('enterprise'),
    userId: z.string().optional(),
  }),

  // Cache (内存缓存)
  cache: z.object({
    ttlUsers: z.number().default(3600),        // 1 hour
    ttlWorkItems: z.number().default(21600),   // 6 hours
  }),

  // Server
  server: z.object({
    transportMode: z.enum(['stdio', 'http']).default('stdio'),
    httpPort: z.number().default(3000),
    httpMaxSessions: z.number().default(100),
    httpSessionTtlMs: z.number().default(30 * 60 * 1000), // 30 min
    toolCallTimeoutMs: z.number().default(300000), // 5 min wall-clock limit per tool call
  }),

  // Auth (HTTP 模式鉴权)
  auth: z.object({
    // API Key（空字符串表示不启用鉴权）— 向后兼容
    apiKey: z.string().default(''),
    // Multi-key support: "key1:id1,key2:id2" for zero-downtime rotation
    apiKeys: z.string().default(''),
    // 信任的代理头（nginx 反向代理场景）
    trustProxy: z.boolean().default(false),
    // 允许的 Origin 列表（逗号分隔，防 DNS rebinding）
    allowedOrigins: z.string().default(''),
    // HTTP 绑定地址（默认仅本地，显式设置 0.0.0.0 暴露到网络）
    httpHost: z.string().default('127.0.0.1'),
  }),

  // API 请求超时（毫秒）
  requestTimeout: z.number().default(15000),

  // Rate Limit
  rateLimit: z.object({
    maxRequestsPerMin: z.number().default(200),
  }),

  // Pagination
  pagination: z.object({
    maxPages: z.number().default(200),
    pageSize: z.number().default(100),
    maxRecords: z.number().default(50000),
    maxFetchDurationMs: z.number().default(180000), // 3 min soft timeout for data fetching
  }),

  // Bulk Fetch Strategy (tiered)
  // All tiers use server-side report_by_id filtering (no unfiltered bulk fetch).
  bulkFetch: z.object({
    smallThreshold: z.number().default(5),         // ≤N: sequential per-user
    mediumThreshold: z.number().default(50),        // ≤N: batched concurrent per-user
    mediumBatchSize: z.number().default(10),         // users per sequential batch (medium tier)
    mediumConcurrency: z.number().default(3),        // concurrent batches (medium tier)
    largeBatchSize: z.number().default(20),          // users per sequential batch (large tier)
    largeConcurrency: z.number().default(5),         // concurrent batches (large tier)
    circuitBreakerMaxPages: z.number().default(1000),
    circuitBreakerMaxRecords: z.number().default(200000),
  }).default({}),

  // Timezone
  timezone: z.string().default('Asia/Shanghai'),

  // Name Matching
  nameMatchStrategy: z.enum(['best', 'strict', 'prompt']).default('best'),

  // Logging
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Data Quality
  dataQuality: z.object({
    // When pagination truncation rate exceeds this threshold, emit elevated warnings
    truncationAlertThreshold: z.number().min(0).max(1).default(0.3),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const raw = {
    pingcode: {
      baseUrl: process.env.PINGCODE_BASE_URL,
      token: process.env.PINGCODE_TOKEN,
      tokenMode: process.env.TOKEN_MODE,
      userId: process.env.PINGCODE_USER_ID,
    },
    cache: {
      ttlUsers: process.env.CACHE_TTL_USERS ? parseInt(process.env.CACHE_TTL_USERS, 10) : undefined,
      ttlWorkItems: process.env.CACHE_TTL_WORK_ITEMS ? parseInt(process.env.CACHE_TTL_WORK_ITEMS, 10) : undefined,
    },
    server: {
      transportMode: process.env.TRANSPORT_MODE,
      httpPort: process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT, 10) : undefined,
      httpMaxSessions: process.env.HTTP_MAX_SESSIONS ? parseInt(process.env.HTTP_MAX_SESSIONS, 10) : undefined,
      httpSessionTtlMs: process.env.HTTP_SESSION_TTL_MS ? parseInt(process.env.HTTP_SESSION_TTL_MS, 10) : undefined,
      toolCallTimeoutMs: process.env.TOOL_CALL_TIMEOUT_MS ? parseInt(process.env.TOOL_CALL_TIMEOUT_MS, 10) : undefined,
    },
    auth: {
      apiKey: process.env.MCP_API_KEY,
      apiKeys: process.env.MCP_API_KEYS,
      trustProxy: process.env.TRUST_PROXY === 'true',
      allowedOrigins: process.env.ALLOWED_ORIGINS,
      httpHost: process.env.HTTP_HOST,
    },
    requestTimeout: process.env.REQUEST_TIMEOUT ? parseInt(process.env.REQUEST_TIMEOUT, 10) : undefined,
    rateLimit: {
      maxRequestsPerMin: process.env.RATE_LIMIT_PER_MIN ? parseInt(process.env.RATE_LIMIT_PER_MIN, 10) : undefined,
    },
    pagination: {
      maxPages: process.env.MAX_PAGES ? parseInt(process.env.MAX_PAGES, 10) : undefined,
      pageSize: process.env.PAGE_SIZE ? parseInt(process.env.PAGE_SIZE, 10) : undefined,
      maxRecords: process.env.MAX_RECORDS ? parseInt(process.env.MAX_RECORDS, 10) : undefined,
      maxFetchDurationMs: process.env.MAX_FETCH_DURATION_MS ? parseInt(process.env.MAX_FETCH_DURATION_MS, 10) : undefined,
    },
    timezone: process.env.TIMEZONE,
    nameMatchStrategy: process.env.NAME_MATCH_STRATEGY,
    logLevel: process.env.LOG_LEVEL,
    dataQuality: {
      truncationAlertThreshold: process.env.TRUNCATION_ALERT_THRESHOLD
        ? parseFloat(process.env.TRUNCATION_ALERT_THRESHOLD)
        : undefined,
    },
  };

  // Remove undefined values for proper default handling
  const cleaned = JSON.parse(JSON.stringify(raw));

  const result = ConfigSchema.safeParse(cleaned);
  if (!result.success) {
    console.error('Configuration validation failed:', result.error.format());
    throw new Error('Invalid configuration');
  }

  return result.data;
}

export const config = loadConfig();
