/**
 * Tests for Issue 3: Multi-key API auth with rotation
 *
 * Tests the real parseApiKeys() and validateApiKey() exports from
 * src/server/http.ts by re-importing the module with different
 * config mocks for each scenario.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Helper: reset modules and re-import http.ts with controlled config.
 * parseApiKeys reads config.auth.apiKey and config.auth.apiKeys at
 * module load time, so we must mock config before each import.
 */
async function loadWithConfig(authConfig: { apiKey?: string; apiKeys?: string }) {
  vi.resetModules();

  vi.doMock('../../src/config/index.js', () => ({
    config: {
      auth: {
        apiKey: authConfig.apiKey ?? '',
        apiKeys: authConfig.apiKeys ?? '',
        allowedOrigins: '',
        httpHost: '127.0.0.1',
        trustProxy: false,
      },
      server: {
        httpPort: 3000,
        httpMaxSessions: 100,
        httpSessionTtlMs: 1800000,
      },
    },
  }));
  vi.doMock('../../src/utils/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }));
  vi.doMock('../../src/utils/metrics.js', () => ({
    metrics: { getSnapshot: vi.fn(), recordSuccess: vi.fn(), recordError: vi.fn() },
  }));

  const mod = await import('../../src/server/http.js');
  return mod;
}

describe('Multi-key API auth (real parseApiKeys)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('single legacy MCP_API_KEY works (backward compat)', async () => {
    const { parseApiKeys } = await loadWithConfig({ apiKey: 'test-key-123' });
    const keys = parseApiKeys();
    expect(keys.size).toBe(1);
    expect(keys.get('test-key-123')).toBe('default');
  });

  it('multi-key format "key1:id1,key2:id2" parses correctly', async () => {
    const { parseApiKeys } = await loadWithConfig({
      apiKeys: 'secret-a:prod-key,secret-b:staging-key',
    });
    const keys = parseApiKeys();
    expect(keys.size).toBe(2);
    expect(keys.get('secret-a')).toBe('prod-key');
    expect(keys.get('secret-b')).toBe('staging-key');
  });

  it('mixed config: both MCP_API_KEY and MCP_API_KEYS', async () => {
    const { parseApiKeys } = await loadWithConfig({
      apiKey: 'legacy-key',
      apiKeys: 'new-key:rotation',
    });
    const keys = parseApiKeys();
    expect(keys.size).toBe(2);
    expect(keys.get('legacy-key')).toBe('default');
    expect(keys.get('new-key')).toBe('rotation');
  });

  it('keys without id get auto-generated ids', async () => {
    const { parseApiKeys } = await loadWithConfig({
      apiKeys: 'keyA,keyB,keyC',
    });
    const keys = parseApiKeys();
    expect(keys.size).toBe(3);
    expect(keys.get('keyA')).toMatch(/^key-\d+$/);
    expect(keys.get('keyB')).toMatch(/^key-\d+$/);
    expect(keys.get('keyC')).toMatch(/^key-\d+$/);
  });

  it('empty config means no keys configured', async () => {
    const { parseApiKeys } = await loadWithConfig({});
    const keys = parseApiKeys();
    expect(keys.size).toBe(0);
  });
});
