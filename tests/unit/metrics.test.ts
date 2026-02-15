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

describe('Metrics data quality tracking', () => {
  beforeEach(() => {
    metrics.reset();
  });

  it('initial snapshot has data_quality with zeros', () => {
    const snapshot = metrics.getSnapshot();
    expect(snapshot.data_quality.total_responses).toBe(0);
    expect(snapshot.data_quality.pagination_truncated).toBe(0);
    expect(snapshot.data_quality.details_truncated).toBe(0);
    expect(snapshot.data_quality.time_sliced).toBe(0);
    expect(snapshot.data_quality.truncation_rate).toBe(0);
  });

  it('recordDataQuality tracks pagination_truncated', () => {
    metrics.recordDataQuality({ paginationTruncated: true });
    metrics.recordDataQuality({ paginationTruncated: false });
    metrics.recordDataQuality({ paginationTruncated: true });
    const snapshot = metrics.getSnapshot();
    expect(snapshot.data_quality.total_responses).toBe(3);
    expect(snapshot.data_quality.pagination_truncated).toBe(2);
    expect(snapshot.data_quality.truncation_rate).toBeCloseTo(2 / 3);
  });

  it('recordDataQuality tracks details_truncated and time_sliced', () => {
    metrics.recordDataQuality({ detailsTruncated: true, timeSliced: true });
    const snapshot = metrics.getSnapshot();
    expect(snapshot.data_quality.details_truncated).toBe(1);
    expect(snapshot.data_quality.time_sliced).toBe(1);
  });

  it('getTruncationRate returns correct rate', () => {
    expect(metrics.getTruncationRate()).toBe(0);
    metrics.recordDataQuality({ paginationTruncated: true });
    metrics.recordDataQuality({});
    expect(metrics.getTruncationRate()).toBe(0.5);
  });

  it('reset() clears data quality metrics', () => {
    metrics.recordDataQuality({ paginationTruncated: true, detailsTruncated: true });
    metrics.reset();
    const snapshot = metrics.getSnapshot();
    expect(snapshot.data_quality.total_responses).toBe(0);
    expect(snapshot.data_quality.pagination_truncated).toBe(0);
    expect(snapshot.data_quality.truncation_rate).toBe(0);
  });
});
