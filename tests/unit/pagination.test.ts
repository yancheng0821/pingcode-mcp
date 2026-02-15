/**
 * Unit 4: Pagination termination + maxPages → paginationTruncated
 *
 * Tests the pagination loop in listWorkloads() with controlled mocked responses:
 * - Normal termination when total <= fetched count
 * - Truncation when currentPage exceeds maxPages
 * - Error during pagination sets paginationTruncated
 * - Deduplication across pages
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted ensures these are available before vi.mock hoisting
const { mockRequest, mockConfig } = vi.hoisted(() => {
  return {
    mockRequest: vi.fn(),
    mockConfig: {
      pagination: {
        maxPages: 200,
        pageSize: 100,
        maxRecords: 50000,
        maxFetchDurationMs: 180000,
      },
    },
  };
});

vi.mock('../../src/api/client.js', () => ({
  apiClient: { request: mockRequest },
  PingCodeApiError: class PingCodeApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('../../src/config/index.js', () => ({
  config: mockConfig,
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/utils/metrics.js', () => ({
  metrics: { recordTimeSlice: vi.fn() },
}));

import { listWorkloads, type WorkloadsResult } from '../../src/api/endpoints/workloads.js';

/** Helper: build a raw workload fixture */
function makeRawWorkload(id: string, reportAt: number) {
  return {
    id,
    principal_type: 'work_item',
    principal: { id: `wi-${id}`, identifier: `WI-${id}`, title: `Item ${id}`, type: 'story' },
    type: { id: 'type-dev', name: 'development' },
    duration: 1,
    description: '',
    report_at: reportAt,
    report_by: { id: 'user-1', name: 'alice', display_name: 'Alice' },
    created_at: reportAt,
  };
}

describe('Pagination termination', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockConfig.pagination.maxPages = 200;
    mockConfig.pagination.pageSize = 100;
    mockConfig.pagination.maxRecords = 50000;
    mockConfig.pagination.maxFetchDurationMs = 180000;
  });

  it('terminates normally when API returns fewer items than total (single page)', async () => {
    mockRequest.mockResolvedValueOnce({
      values: [makeRawWorkload('w1', 1000), makeRawWorkload('w2', 1001)],
      total: 2,
      page_index: 0,
      page_size: 100,
    });

    const result: WorkloadsResult = await listWorkloads({
      startAt: 0,
      endAt: 9999,
    });

    expect(result.paginationTruncated).toBe(false);
    expect(result.workloads).toHaveLength(2);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('terminates normally after multiple pages when total is reached', async () => {
    mockConfig.pagination.pageSize = 2;
    // Page 0: 2 items, total = 5
    mockRequest.mockResolvedValueOnce({
      values: [makeRawWorkload('w1', 1000), makeRawWorkload('w2', 1001)],
      total: 5,
      page_index: 0,
      page_size: 2,
    });
    // Page 1: 2 items
    mockRequest.mockResolvedValueOnce({
      values: [makeRawWorkload('w3', 1002), makeRawWorkload('w4', 1003)],
      total: 5,
      page_index: 1,
      page_size: 2,
    });
    // Page 2: 1 item (last page)
    mockRequest.mockResolvedValueOnce({
      values: [makeRawWorkload('w5', 1004)],
      total: 5,
      page_index: 2,
      page_size: 2,
    });

    const result = await listWorkloads({ startAt: 0, endAt: 9999, pageSize: 2 });

    expect(result.paginationTruncated).toBe(false);
    expect(result.workloads).toHaveLength(5);
    expect(mockRequest).toHaveBeenCalledTimes(3);
  });

  it('sets paginationTruncated=true when maxPages is exceeded', async () => {
    mockConfig.pagination.maxPages = 2; // Allow only 2 pages (page_index 0 and 1), truncate at page_index > 2
    mockConfig.pagination.pageSize = 1;

    // Each page returns 1 item, total claims 100
    for (let i = 0; i < 3; i++) {
      mockRequest.mockResolvedValueOnce({
        values: [makeRawWorkload(`w${i}`, 1000 + i)],
        total: 100,
        page_index: i,
        page_size: 1,
      });
    }

    const result = await listWorkloads({ startAt: 0, endAt: 9999, pageSize: 1 });

    expect(result.paginationTruncated).toBe(true);
    expect(result.truncationReasons).toContain('max_pages');
    // Should have fetched pages 0, 1, 2, then on page 3 (currentPage > maxPages=2) → break
    expect(result.workloads).toHaveLength(3);
  });

  it('sets paginationTruncated=true when API request throws', async () => {
    mockRequest.mockRejectedValueOnce(new Error('Network error'));

    const result = await listWorkloads({ startAt: 0, endAt: 9999 });

    expect(result.paginationTruncated).toBe(true);
    expect(result.truncationReasons).toContain('fetch_error');
    expect(result.workloads).toHaveLength(0);
  });

  it('sets paginationTruncated=true when maxRecords is exceeded', async () => {
    mockConfig.pagination.maxRecords = 3;
    mockConfig.pagination.pageSize = 2;

    // Page 0: 2 items, total = 10
    mockRequest.mockResolvedValueOnce({
      values: [makeRawWorkload('w1', 1000), makeRawWorkload('w2', 1001)],
      total: 10,
      page_index: 0,
      page_size: 2,
    });
    // Page 1: 2 more items → total collected = 4, exceeds maxRecords=3
    mockRequest.mockResolvedValueOnce({
      values: [makeRawWorkload('w3', 1002), makeRawWorkload('w4', 1003)],
      total: 10,
      page_index: 1,
      page_size: 2,
    });

    const result = await listWorkloads({ startAt: 0, endAt: 9999, pageSize: 2 });

    expect(result.paginationTruncated).toBe(true);
    expect(result.truncationReasons).toContain('max_records');
    // Should stop after hitting maxRecords (collected 4, but cap was 3)
    // The check happens after adding the page items, so we get 4
    expect(result.workloads.length).toBeGreaterThanOrEqual(3);
    expect(result.workloads.length).toBeLessThanOrEqual(4);
  });

  it('sets paginationTruncated=true with timeout reason when maxFetchDurationMs exceeded', async () => {
    mockConfig.pagination.maxFetchDurationMs = 50; // 50ms soft limit
    mockConfig.pagination.pageSize = 2;

    // Mock a slow API response — takes 100ms, exceeding the 50ms limit
    mockRequest.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return {
        values: [makeRawWorkload('w1', 1000), makeRawWorkload('w2', 1001)],
        total: 10,
        page_index: 0,
        page_size: 2,
      };
    });

    const result = await listWorkloads({ startAt: 0, endAt: 9999, pageSize: 2 });

    // First page completes (100ms), then elapsed check fires before second page fetch
    expect(result.paginationTruncated).toBe(true);
    expect(result.truncationReasons).toContain('timeout');
    expect(result.workloads).toHaveLength(2); // got first page only
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('deduplicates workloads across pages by id', async () => {
    mockConfig.pagination.pageSize = 2;
    // Page 0: w1, w2
    mockRequest.mockResolvedValueOnce({
      values: [makeRawWorkload('w1', 1000), makeRawWorkload('w2', 1001)],
      total: 3,
      page_index: 0,
      page_size: 2,
    });
    // Page 1: w2 (duplicate), w3
    mockRequest.mockResolvedValueOnce({
      values: [makeRawWorkload('w2', 1001), makeRawWorkload('w3', 1002)],
      total: 3,
      page_index: 1,
      page_size: 2,
    });

    const result = await listWorkloads({ startAt: 0, endAt: 9999, pageSize: 2 });

    expect(result.workloads).toHaveLength(3); // w1, w2, w3 (w2 deduplicated)
    const ids = result.workloads.map(w => w.id);
    expect(ids).toEqual(['w1', 'w2', 'w3']);
  });
});
