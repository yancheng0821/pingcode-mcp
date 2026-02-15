import { describe, it, expect } from 'vitest';
import { parseTimeRange, splitTimeRange, isTimeRangeExceedsThreeMonths } from '../../src/utils/timeUtils.js';

describe('parseTimeRange', () => {
  it('parses date strings (yyyy-MM-dd)', () => {
    const range = parseTimeRange('2026-01-01', '2026-01-31');
    expect(range.start).toBeLessThan(range.end);
    // start should be Jan 1 in Shanghai timezone
    const startDate = new Date(range.start * 1000);
    expect(startDate.getFullYear()).toBe(2026);
  });

  it('parses date strings (yyyy/MM/dd)', () => {
    const range = parseTimeRange('2026/01/01', '2026/01/31');
    expect(range.start).toBeLessThan(range.end);
  });

  it('parses Chinese alias "本月" for both start and end', () => {
    const range = parseTimeRange('本月', '本月');
    expect(range.start).toBeLessThan(range.end);
  });

  it('parses English alias "this_week"', () => {
    const range = parseTimeRange('this_week', 'this_week');
    expect(range.start).toBeLessThan(range.end);
  });

  it('parses mixed aliases: Chinese start + date end', () => {
    const range = parseTimeRange('本月', '2099-12-31');
    expect(range.start).toBeLessThan(range.end);
  });

  it('throws on invalid date input', () => {
    expect(() => parseTimeRange('not-a-date', '2026-01-31')).toThrow('Invalid time input');
  });

  it('throws when start >= end', () => {
    expect(() => parseTimeRange('2026-02-01', '2026-01-01')).toThrow('Start time must be before end time');
  });

  it('handles "yesterday" alias', () => {
    const range = parseTimeRange('昨天', '昨天');
    expect(range.start).toBeLessThan(range.end);
  });

  it('handles "last_week" alias', () => {
    const range = parseTimeRange('上周', '上周');
    expect(range.start).toBeLessThan(range.end);
  });

  it('handles "last_month" alias', () => {
    const range = parseTimeRange('上月', '上月');
    expect(range.start).toBeLessThan(range.end);
  });
});

describe('splitTimeRange', () => {
  const THREE_MONTHS_SECONDS = 90 * 24 * 60 * 60;

  it('returns single chunk for range under 3 months', () => {
    const start = 1700000000;
    const end = start + 30 * 24 * 60 * 60; // 30 days
    const chunks = splitTimeRange(start, end);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual([start, end]);
  });

  it('splits range exceeding 3 months into multiple chunks', () => {
    const start = 1700000000;
    const end = start + 200 * 24 * 60 * 60; // 200 days
    const chunks = splitTimeRange(start, end);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should be exactly 3 months
    expect(chunks[0][1] - chunks[0][0]).toBe(THREE_MONTHS_SECONDS);
    // Last chunk should end at end
    expect(chunks[chunks.length - 1][1]).toBe(end);
  });

  it('chunks are contiguous', () => {
    const start = 1700000000;
    const end = start + 365 * 24 * 60 * 60;
    const chunks = splitTimeRange(start, end);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i][0]).toBe(chunks[i - 1][1]);
    }
  });
});

describe('isTimeRangeExceedsThreeMonths', () => {
  const THREE_MONTHS_SECONDS = 90 * 24 * 60 * 60;

  it('returns false for range under 3 months', () => {
    expect(isTimeRangeExceedsThreeMonths(0, THREE_MONTHS_SECONDS - 1)).toBe(false);
  });

  it('returns false for exactly 3 months', () => {
    expect(isTimeRangeExceedsThreeMonths(0, THREE_MONTHS_SECONDS)).toBe(false);
  });

  it('returns true for range over 3 months', () => {
    expect(isTimeRangeExceedsThreeMonths(0, THREE_MONTHS_SECONDS + 1)).toBe(true);
  });
});
