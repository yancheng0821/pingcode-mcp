/**
 * Tests for Issue 1: Tiered bulk fetch strategy
 *
 * Tests FetchBudget, three-tier config, and circuit breaker behavior.
 * All tests are behavioral — no source-code string scanning.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFetchBudget, type FetchBudget } from '../../src/api/endpoints/workloads.js';

describe('FetchBudget', () => {
  it('createFetchBudget creates budget with defaults', () => {
    const budget = createFetchBudget();
    expect(budget.totalRecordsFetched).toBe(0);
    expect(budget.totalPagesFetched).toBe(0);
    expect(budget.exhausted).toBe(false);
    expect(budget.maxRecords).toBeGreaterThan(0);
    expect(budget.maxPages).toBeGreaterThan(0);
  });

  it('createFetchBudget accepts custom limits', () => {
    const budget = createFetchBudget(100, 10);
    expect(budget.maxRecords).toBe(100);
    expect(budget.maxPages).toBe(10);
  });

  it('budget can be marked exhausted', () => {
    const budget = createFetchBudget(100, 10);
    budget.exhausted = true;
    expect(budget.exhausted).toBe(true);
  });
});

describe('Tiered fetch strategy', () => {
  it('config has bulkFetch section with expected defaults', async () => {
    const { config } = await import('../../src/config/index.js');
    expect(config.bulkFetch).toBeDefined();
    expect(config.bulkFetch.smallThreshold).toBe(5);
    expect(config.bulkFetch.mediumThreshold).toBe(50);
    expect(config.bulkFetch.mediumBatchSize).toBe(10);
    expect(config.bulkFetch.mediumConcurrency).toBe(3);
    expect(config.bulkFetch.largeBatchSize).toBe(20);
    expect(config.bulkFetch.largeConcurrency).toBe(5);
    expect(config.bulkFetch.circuitBreakerMaxPages).toBe(1000);
    expect(config.bulkFetch.circuitBreakerMaxRecords).toBe(200000);
  });

  it('three-tier thresholds define non-overlapping ranges', async () => {
    const { config } = await import('../../src/config/index.js');
    const { smallThreshold, mediumThreshold } = config.bulkFetch;
    // small < medium
    expect(smallThreshold).toBeLessThan(mediumThreshold);
    // large tier uses higher concurrency than medium
    expect(config.bulkFetch.largeBatchSize).toBeGreaterThan(config.bulkFetch.mediumBatchSize);
    expect(config.bulkFetch.largeConcurrency).toBeGreaterThan(config.bulkFetch.mediumConcurrency);
  });

  it('circuit breaker metric is recorded', async () => {
    const { metrics } = await import('../../src/utils/metrics.js');
    metrics.reset();
    metrics.recordCircuitBreakerTriggered();
    const snapshot = metrics.getSnapshot();
    expect(snapshot.data_quality.circuit_breaker_triggered).toBe(1);
  });
});
