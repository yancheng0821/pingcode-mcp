import { describe, it, expect } from 'vitest';
import { computeDelay } from '../../src/api/client.js';

describe('computeDelay (retry jitter)', () => {
  it('attempt 0 returns value in [500, 1000] range (baseDelay=1000)', () => {
    for (let i = 0; i < 20; i++) {
      const delay = computeDelay(0, 1000, 10000);
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(1000);
    }
  });

  it('attempt 1 returns value in [1000, 2000] range', () => {
    for (let i = 0; i < 20; i++) {
      const delay = computeDelay(1, 1000, 10000);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(2000);
    }
  });

  it('attempt 2 returns value in [2000, 4000] range', () => {
    for (let i = 0; i < 20; i++) {
      const delay = computeDelay(2, 1000, 10000);
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(4000);
    }
  });

  it('high attempts cap at maxDelay range', () => {
    for (let i = 0; i < 20; i++) {
      const delay = computeDelay(20, 1000, 10000);
      expect(delay).toBeGreaterThanOrEqual(5000);
      expect(delay).toBeLessThanOrEqual(10000);
    }
  });

  it('multiple calls produce different values (non-deterministic)', () => {
    const values = new Set<number>();
    for (let i = 0; i < 10; i++) {
      values.add(computeDelay(1, 1000, 10000));
    }
    // With 10 random samples, we should get at least 2 distinct values
    expect(values.size).toBeGreaterThanOrEqual(2);
  });
});
