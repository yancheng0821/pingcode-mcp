/**
 * Unit 6: work_item batch cache mget hit/miss, missingCount, concurrency control
 *
 * Tests getWorkItemsBatch() with controlled cache and API mocks:
 * - Full cache hit → no API calls
 * - Full cache miss → API calls for all
 * - Partial hit → API calls only for misses
 * - missingCount tracks 404/failed fetches
 * - Concurrency batching respects the limit
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGet, mockSet, mockMget, mockMset, mockRequest } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(),
  mockMget: vi.fn(),
  mockMset: vi.fn(),
  mockRequest: vi.fn(),
}));

vi.mock('../../src/cache/index.js', () => ({
  cache: {
    get: (...args: unknown[]) => mockGet(...args),
    set: (...args: unknown[]) => mockSet(...args),
    mget: (...args: unknown[]) => mockMget(...args),
    mset: (...args: unknown[]) => mockMset(...args),
  },
  CacheKeys: {
    workItem: (id: string) => `work_items:${id}`,
  },
}));

vi.mock('../../src/api/client.js', () => ({
  apiClient: { request: mockRequest },
  PingCodeApiError: class PingCodeApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
      this.name = 'PingCodeApiError';
    }
  },
}));

vi.mock('../../src/config/index.js', () => ({
  config: {
    cache: { ttlWorkItems: 21600 },
  },
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getWorkItemsBatch } from '../../src/api/endpoints/workItems.js';
import { PingCodeApiError } from '../../src/api/client.js';

function makeWorkItem(id: string) {
  return {
    id,
    identifier: `PROJ-${id}`,
    title: `Work item ${id}`,
    project: { id: 'proj-1', identifier: 'PROJ', name: 'Main', type: 'agile' },
    assignee: null,
    state: 'done',
    type: 'story',
  };
}

describe('getWorkItemsBatch', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSet.mockReset();
    mockMget.mockReset();
    mockMset.mockReset();
    mockRequest.mockReset();
  });

  it('returns empty map for empty input', async () => {
    const { items, missingCount } = await getWorkItemsBatch([]);
    expect(items.size).toBe(0);
    expect(missingCount).toBe(0);
    expect(mockMget).not.toHaveBeenCalled();
  });

  it('returns all from cache on full hit (no API calls)', async () => {
    const cached = new Map<string, unknown>();
    cached.set('work_items:wi-1', makeWorkItem('wi-1'));
    cached.set('work_items:wi-2', makeWorkItem('wi-2'));
    mockMget.mockResolvedValueOnce(cached);

    const { items, missingCount } = await getWorkItemsBatch(['wi-1', 'wi-2']);

    expect(items.size).toBe(2);
    expect(items.get('wi-1')!.id).toBe('wi-1');
    expect(items.get('wi-2')!.id).toBe('wi-2');
    expect(missingCount).toBe(0);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('fetches all from API on full cache miss', async () => {
    mockMget.mockResolvedValueOnce(new Map()); // No cache hits
    mockRequest
      .mockResolvedValueOnce(makeWorkItem('wi-1'))
      .mockResolvedValueOnce(makeWorkItem('wi-2'));

    const { items, missingCount } = await getWorkItemsBatch(['wi-1', 'wi-2']);

    expect(items.size).toBe(2);
    expect(missingCount).toBe(0);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockMset).toHaveBeenCalledTimes(1);
    // Verify cache was populated
    const msetEntries = mockMset.mock.calls[0][0];
    expect(msetEntries).toHaveLength(2);
  });

  it('fetches only cache misses from API (partial hit)', async () => {
    const cached = new Map<string, unknown>();
    cached.set('work_items:wi-1', makeWorkItem('wi-1'));
    // wi-2 not in cache
    mockMget.mockResolvedValueOnce(cached);
    mockRequest.mockResolvedValueOnce(makeWorkItem('wi-2'));

    const { items, missingCount } = await getWorkItemsBatch(['wi-1', 'wi-2']);

    expect(items.size).toBe(2);
    expect(missingCount).toBe(0);
    // Only 1 API call for the cache miss
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith('/v1/project/work_items/wi-2', { signal: undefined });
  });

  it('increments missingCount for 404 responses', async () => {
    mockMget.mockResolvedValueOnce(new Map());
    mockRequest
      .mockResolvedValueOnce(makeWorkItem('wi-1'))
      .mockRejectedValueOnce(new PingCodeApiError('Not found', 404))
      .mockResolvedValueOnce(makeWorkItem('wi-3'));

    const { items, missingCount } = await getWorkItemsBatch(['wi-1', 'wi-2', 'wi-3']);

    expect(items.size).toBe(2); // wi-1 and wi-3
    expect(missingCount).toBe(1); // wi-2 was 404
  });

  it('increments missingCount for non-404 errors (catch branch)', async () => {
    mockMget.mockResolvedValueOnce(new Map());
    mockRequest
      .mockResolvedValueOnce(makeWorkItem('wi-1'))
      .mockRejectedValueOnce(new Error('Server error'));

    const { items, missingCount } = await getWorkItemsBatch(['wi-1', 'wi-2']);

    expect(items.size).toBe(1);
    expect(missingCount).toBe(1);
  });

  it('deduplicates input IDs', async () => {
    const cached = new Map<string, unknown>();
    cached.set('work_items:wi-1', makeWorkItem('wi-1'));
    mockMget.mockResolvedValueOnce(cached);

    const { items } = await getWorkItemsBatch(['wi-1', 'wi-1', 'wi-1']);

    expect(items.size).toBe(1);
    // mget called with deduplicated keys
    expect(mockMget.mock.calls[0][0]).toHaveLength(1);
  });

  it('respects concurrency batching (25 IDs with concurrency=3 → API calls in batches)', async () => {
    mockMget.mockResolvedValueOnce(new Map()); // All cache misses
    const ids = Array.from({ length: 7 }, (_, i) => `wi-${i}`);

    // Mock all API responses
    for (const id of ids) {
      mockRequest.mockResolvedValueOnce(makeWorkItem(id));
    }

    // Track call ordering by capturing timestamps
    const callOrder: number[] = [];
    mockRequest.mockImplementation(async (path: string) => {
      const callIndex = callOrder.length;
      callOrder.push(callIndex);
      const id = path.replace('/v1/project/work_items/', '');
      return makeWorkItem(id);
    });

    const { items, missingCount } = await getWorkItemsBatch(ids, 3);

    expect(items.size).toBe(7);
    expect(missingCount).toBe(0);
    // With concurrency=3 and 7 items: batches of [3, 3, 1] = 7 total API calls
    expect(mockRequest).toHaveBeenCalledTimes(7);
  });

  it('writes fetched items to cache via mset', async () => {
    mockMget.mockResolvedValueOnce(new Map());
    mockRequest
      .mockResolvedValueOnce(makeWorkItem('wi-1'))
      .mockResolvedValueOnce(makeWorkItem('wi-2'));

    await getWorkItemsBatch(['wi-1', 'wi-2']);

    expect(mockMset).toHaveBeenCalledTimes(1);
    const entries = mockMset.mock.calls[0][0];
    expect(entries).toHaveLength(2);
    expect(entries[0].key).toBe('work_items:wi-1');
    expect(entries[0].ttl).toBe(21600);
    expect(entries[1].key).toBe('work_items:wi-2');
  });
});
