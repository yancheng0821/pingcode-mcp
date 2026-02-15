import { describe, it, expect } from 'vitest';
import { isBusinessError } from '../../src/server/mcp.js';

describe('isBusinessError', () => {
  it('returns true for object with error + code strings', () => {
    expect(isBusinessError({ error: 'Not found', code: 'USER_NOT_FOUND' })).toBe(true);
  });

  it('returns true for NO_DATA code', () => {
    expect(isBusinessError({ error: 'No data', code: 'NO_DATA' })).toBe(true);
  });

  it('returns true for INTERNAL_ERROR code', () => {
    expect(isBusinessError({ error: 'Oops', code: 'INTERNAL_ERROR' })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isBusinessError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isBusinessError(undefined)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isBusinessError('string')).toBe(false);
    expect(isBusinessError(42)).toBe(false);
  });

  it('returns false for object missing code', () => {
    expect(isBusinessError({ error: 'oops' })).toBe(false);
  });

  it('returns false for object missing error', () => {
    expect(isBusinessError({ code: 'ERR' })).toBe(false);
  });

  it('returns false for object with non-string error', () => {
    expect(isBusinessError({ error: 123, code: 'ERR' })).toBe(false);
  });

  it('returns false for normal result (no error/code)', () => {
    expect(isBusinessError({ summary: {}, details: [] })).toBe(false);
  });
});
