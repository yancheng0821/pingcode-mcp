import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  params?: Record<string, string | number | undefined>;
  body?: unknown;
}

interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  retryableStatus: number[];
}

const RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  retryableStatus: [429, 500, 502, 503, 504],
};

// Simple rate limiter
class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      const oldestTimestamp = this.timestamps[0];
      const waitTime = this.windowMs - (now - oldestTimestamp);
      logger.debug({ waitTime }, 'Rate limit reached, waiting');
      await this.sleep(waitTime);
      return this.acquire();
    }

    this.timestamps.push(now);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export class PingCodeApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly rateLimiter: RateLimiter;

  constructor() {
    this.baseUrl = config.pingcode.baseUrl;
    this.token = config.pingcode.token;
    this.rateLimiter = new RateLimiter(
      config.rateLimit.maxRequestsPerMin,
      60 * 1000
    );
  }

  async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', params, body } = options;

    // Build URL with query params
    const url = new URL(endpoint, this.baseUrl);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.append(key, String(value));
        }
      });
    }

    // Wait for rate limiter
    await this.rateLimiter.acquire();

    const startTime = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
      try {
        const response = await fetch(url.toString(), {
          method,
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        const duration = Date.now() - startTime;

        if (!response.ok) {
          const shouldRetry = RETRY_CONFIG.retryableStatus.includes(response.status);

          if (shouldRetry && attempt < RETRY_CONFIG.maxRetries) {
            const delay = Math.min(
              RETRY_CONFIG.baseDelay * Math.pow(2, attempt),
              RETRY_CONFIG.maxDelay
            );
            logger.warn({
              endpoint,
              status: response.status,
              attempt,
              delay
            }, 'Request failed, retrying');
            await this.sleep(delay);
            continue;
          }

          const errorBody = await response.text();
          logger.error({
            endpoint,
            status: response.status,
            duration,
            error: errorBody
          }, 'API request failed');

          // 记录失败指标
          metrics.recordError(`api:${endpoint}`, duration);

          throw new PingCodeApiError(
            response.status,
            `API request failed: ${response.status}`,
            errorBody
          );
        }

        const data = await response.json() as T;

        logger.debug({
          endpoint,
          status: response.status,
          duration
        }, 'API request completed');

        // 记录成功指标
        metrics.recordSuccess(`api:${endpoint}`, duration);

        return data;
      } catch (error) {
        if (error instanceof PingCodeApiError) {
          throw error;
        }
        lastError = error as Error;

        if (attempt < RETRY_CONFIG.maxRetries) {
          const delay = Math.min(
            RETRY_CONFIG.baseDelay * Math.pow(2, attempt),
            RETRY_CONFIG.maxDelay
          );
          logger.warn({
            endpoint,
            error: lastError.message,
            attempt,
            delay
          }, 'Request error, retrying');
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error('Request failed after retries');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export class PingCodeApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: string
  ) {
    super(message);
    this.name = 'PingCodeApiError';
  }
}

// Singleton instance
export const apiClient = new PingCodeApiClient();
