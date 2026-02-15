import { describe, it, expect, beforeEach } from 'vitest';
import { metrics } from '../../src/utils/metrics.js';

describe('Metrics retry tracking', () => {
  beforeEach(() => {
    metrics.reset();
  });

  it('initial snapshot has retries.total_retries === 0', () => {
    const snapshot = metrics.getSnapshot();
    expect(snapshot.retries.total_retries).toBe(0);
    expect(snapshot.retries.rate_limit_exhausted).toBe(0);
  });

  it('recordRetry() increments total_retries', () => {
    metrics.recordRetry();
    metrics.recordRetry();
    metrics.recordRetry();
    const snapshot = metrics.getSnapshot();
    expect(snapshot.retries.total_retries).toBe(3);
  });

  it('recordRateLimitExhausted() increments rate_limit_exhausted', () => {
    metrics.recordRateLimitExhausted();
    metrics.recordRateLimitExhausted();
    const snapshot = metrics.getSnapshot();
    expect(snapshot.retries.rate_limit_exhausted).toBe(2);
  });

  it('reset() clears retry metrics', () => {
    metrics.recordRetry();
    metrics.recordRetry();
    metrics.recordRateLimitExhausted();
    metrics.reset();
    const snapshot = metrics.getSnapshot();
    expect(snapshot.retries.total_retries).toBe(0);
    expect(snapshot.retries.rate_limit_exhausted).toBe(0);
  });
});
