import { describe, it, expect } from 'vitest';
import { RateLimiter, parseRetryAfter } from '../../src/api/client.js';

describe('RateLimiter', () => {
  it('allows requests up to maxRequests', async () => {
    const limiter = new RateLimiter(3, 1000);
    // Should not throw for first 3 requests
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
  });

  it('blocks after maxRequests are exhausted then recovers', async () => {
    const limiter = new RateLimiter(2, 100); // 100ms window
    await limiter.acquire();
    await limiter.acquire();
    // 3rd request must wait for window to expire
    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    // Should have waited roughly 100ms (allow some slack)
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  it('AbortSignal cancels waiting', async () => {
    const limiter = new RateLimiter(1, 60000); // 60s window
    await limiter.acquire();
    // 2nd request will be blocked; abort immediately
    const controller = new AbortController();
    controller.abort();
    await expect(limiter.acquire(controller.signal)).rejects.toThrow('Rate limit wait aborted');
  });

  it('AbortSignal cancels mid-wait', async () => {
    const limiter = new RateLimiter(1, 60000);
    await limiter.acquire();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(limiter.acquire(controller.signal)).rejects.toThrow('Rate limit wait aborted');
  });
});

describe('parseRetryAfter', () => {
  it('parses numeric seconds', () => {
    expect(parseRetryAfter('5')).toBe(5000);
  });

  it('returns null for zero', () => {
    expect(parseRetryAfter('0')).toBeNull();
  });

  it('returns null for negative', () => {
    expect(parseRetryAfter('-1')).toBeNull();
  });

  it('returns null for garbage', () => {
    expect(parseRetryAfter('not-a-number-or-date')).toBeNull();
  });

  it('parses future HTTP-date', () => {
    const futureDate = new Date(Date.now() + 10000).toUTCString();
    const result = parseRetryAfter(futureDate);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(0);
    expect(result!).toBeLessThanOrEqual(11000);
  });
});
