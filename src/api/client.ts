import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  params?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal;
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

/**
 * 解析 Retry-After 头（支持秒数和 HTTP-date 两种格式）
 * 返回等待毫秒数，无法解析时返回 null
 */
export function parseRetryAfter(value: string): number | null {
  // 尝试解析为秒数（纯数字字符串）
  const seconds = Number(value);
  if (!Number.isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  // 尝试解析为 HTTP-date
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    const delayMs = dateMs - Date.now();
    return delayMs > 0 ? delayMs : null;
  }
  return null;
}

/**
 * Compute retry delay with full jitter.
 * Returns a value in [base * 2^attempt * 0.5, base * 2^attempt * 1.0],
 * capped at maxDelay.
 */
export function computeDelay(
  attempt: number,
  baseDelay: number = RETRY_CONFIG.baseDelay,
  maxDelay: number = RETRY_CONFIG.maxDelay,
): number {
  const exponential = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  // Full jitter: 50-100% of exponential value
  return exponential * (0.5 + Math.random() * 0.5);
}

// Simple rate limiter
export class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new DOMException('Rate limit wait aborted', 'AbortError');
    }

    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      const oldestTimestamp = this.timestamps[0];
      const waitTime = this.windowMs - (now - oldestTimestamp);
      logger.debug({ waitTime }, 'Rate limit reached, waiting');
      await this.sleep(waitTime, signal);
      return this.acquire(signal);
    }

    this.timestamps.push(now);
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Rate limit wait aborted', 'AbortError'));
        return;
      }
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Rate limit wait aborted', 'AbortError'));
        }, { once: true });
      }
    });
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
    const { method = 'GET', params, body, signal } = options;

    // Check if already aborted before starting
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }

    // Build URL with query params
    const url = new URL(endpoint, this.baseUrl);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.append(key, String(value));
        }
      });
    }

    // Wait for rate limiter (with timeout to prevent indefinite blocking)
    const rateLimitController = new AbortController();
    const rateLimitTimeout = setTimeout(
      () => rateLimitController.abort(),
      config.requestTimeout
    );
    try {
      const rateLimitSignal = signal
        ? AbortSignal.any([rateLimitController.signal, signal])
        : rateLimitController.signal;
      await this.rateLimiter.acquire(rateLimitSignal);
    } catch (error) {
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError');
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Rate limit wait timed out after ${config.requestTimeout}ms: ${endpoint}`);
      }
      throw error;
    } finally {
      clearTimeout(rateLimitTimeout);
    }

    const startTime = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
      // Check external signal before each retry attempt
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError');
      }

      // 每次请求创建独立的 AbortController（超时自动取消）
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.requestTimeout);

      // Merge timeout signal with external signal
      const fetchSignal = signal
        ? AbortSignal.any([controller.signal, signal])
        : controller.signal;

      try {
        const response = await fetch(url.toString(), {
          method,
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: fetchSignal,
        });

        clearTimeout(timeoutId);
        const duration = Date.now() - startTime;

        if (!response.ok) {
          const shouldRetry = RETRY_CONFIG.retryableStatus.includes(response.status);

          if (shouldRetry && attempt < RETRY_CONFIG.maxRetries) {
            // 429 优先使用 Retry-After 头指定的等待时间（不加 jitter）
            let delay: number;
            if (response.status === 429) {
              const retryAfter = response.headers.get('retry-after');
              const parsedRetryMs = retryAfter ? parseRetryAfter(retryAfter) : null;
              if (parsedRetryMs !== null) {
                // Server-specified delay: use as-is (no jitter)
                delay = Math.min(parsedRetryMs, RETRY_CONFIG.maxDelay);
              } else {
                // 429 without Retry-After: use jittered backoff
                delay = computeDelay(attempt);
              }
            } else {
              delay = computeDelay(attempt);
            }
            metrics.recordRetry();
            logger.warn({
              endpoint,
              status: response.status,
              attempt,
              delay
            }, 'Request failed, retrying');
            await this.sleep(delay);
            continue;
          }

          // 429 retries exhausted
          if (response.status === 429) {
            metrics.recordRateLimitExhausted();
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
        clearTimeout(timeoutId);

        if (error instanceof PingCodeApiError) {
          throw error;
        }

        // External signal aborted → propagate immediately, don't retry
        if (signal?.aborted) {
          throw new DOMException('The operation was aborted', 'AbortError');
        }

        // AbortError = 请求超时
        if (error instanceof DOMException && error.name === 'AbortError') {
          const duration = Date.now() - startTime;
          lastError = new Error(
            `Request to ${endpoint} timed out after ${config.requestTimeout}ms`
          );

          if (attempt < RETRY_CONFIG.maxRetries) {
            metrics.recordRetry();
            logger.warn({
              endpoint,
              timeout: config.requestTimeout,
              attempt,
            }, 'Request timed out, retrying');
            await this.sleep(computeDelay(attempt));
            continue;
          }

          metrics.recordError(`api:${endpoint}`, duration);
          throw lastError;
        }

        lastError = error as Error;

        if (attempt < RETRY_CONFIG.maxRetries) {
          const delay = computeDelay(attempt);
          metrics.recordRetry();
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
