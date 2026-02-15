/**
 * Tests for src/utils/sanitize.ts
 *
 * Verifies control char stripping, truncation, and null passthrough.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeExternalText,
  sanitizeTitle,
  sanitizeName,
  sanitizeDescription,
} from '../../src/utils/sanitize.js';

describe('sanitizeExternalText', () => {
  it('returns undefined for null/undefined input', () => {
    expect(sanitizeExternalText(null)).toBeUndefined();
    expect(sanitizeExternalText(undefined)).toBeUndefined();
  });

  it('strips control chars but preserves \\t, \\n, \\r', () => {
    const input = 'Hello\x00World\x01!\tTab\nNewline\rCarriage\x7FDel\x80End';
    const result = sanitizeExternalText(input);
    // Control chars are stripped (removed), \t \n \r are preserved
    expect(result).toBe('HelloWorld!\tTab\nNewline\rCarriageDelEnd');
  });

  it('preserves normal text unchanged', () => {
    const input = 'Normal text with spaces and 数字123';
    expect(sanitizeExternalText(input)).toBe(input);
  });

  it('truncates text exceeding maxLength with suffix', () => {
    const input = 'A'.repeat(100);
    const result = sanitizeExternalText(input, { maxLength: 50 });
    expect(result!.length).toBeLessThanOrEqual(50);
    expect(result).toContain('…[truncated]');
  });

  it('does not truncate text within maxLength', () => {
    const input = 'Short text';
    expect(sanitizeExternalText(input, { maxLength: 500 })).toBe(input);
  });
});

describe('sanitizeTitle', () => {
  it('truncates at 500 chars', () => {
    const input = 'X'.repeat(1000);
    const result = sanitizeTitle(input);
    expect(result!.length).toBeLessThanOrEqual(500);
  });
});

describe('sanitizeName', () => {
  it('truncates at 200 chars', () => {
    const input = 'N'.repeat(500);
    const result = sanitizeName(input);
    expect(result!.length).toBeLessThanOrEqual(200);
  });
});

describe('sanitizeDescription', () => {
  it('truncates at 2000 chars', () => {
    const input = 'D'.repeat(5000);
    const result = sanitizeDescription(input);
    expect(result!.length).toBeLessThanOrEqual(2000);
  });
});
