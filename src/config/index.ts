import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  // PingCode API
  pingcode: z.object({
    baseUrl: z.string().url().default('https://open.pingcode.com'),
    token: z.string().min(1, 'PINGCODE_TOKEN is required'),
    tokenMode: z.enum(['enterprise', 'user']).default('enterprise'),
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
  }),

  // Auth (HTTP 模式鉴权)
  auth: z.object({
    // API Key（空字符串表示不启用鉴权）
    apiKey: z.string().default(''),
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
  }),

  // Timezone
  timezone: z.string().default('Asia/Shanghai'),

  // Name Matching
  nameMatchStrategy: z.enum(['best', 'strict', 'prompt']).default('best'),

  // Logging
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const raw = {
    pingcode: {
      baseUrl: process.env.PINGCODE_BASE_URL,
      token: process.env.PINGCODE_TOKEN,
      tokenMode: process.env.TOKEN_MODE,
    },
    cache: {
      ttlUsers: process.env.CACHE_TTL_USERS ? parseInt(process.env.CACHE_TTL_USERS, 10) : undefined,
      ttlWorkItems: process.env.CACHE_TTL_WORK_ITEMS ? parseInt(process.env.CACHE_TTL_WORK_ITEMS, 10) : undefined,
    },
    server: {
      transportMode: process.env.TRANSPORT_MODE,
      httpPort: process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT, 10) : undefined,
    },
    auth: {
      apiKey: process.env.MCP_API_KEY,
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
    },
    timezone: process.env.TIMEZONE,
    nameMatchStrategy: process.env.NAME_MATCH_STRATEGY,
    logLevel: process.env.LOG_LEVEL,
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
