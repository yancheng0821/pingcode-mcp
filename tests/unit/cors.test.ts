/**
 * Unit tests for CORS default-deny behavior.
 *
 * Tests the exported isOriginAllowed() and setCorsHeaders() helpers
 * from src/server/http.ts to verify:
 * - No Origin header → allowed (non-browser requests)
 * - Empty whitelist + Origin → denied (default-deny)
 * - Whitelisted Origin → allowed
 * - Non-whitelisted Origin → denied
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to control the config.auth.allowedOrigins value before http.ts loads
// and computes the allowedOrigins Set at module scope.

describe('CORS: isOriginAllowed + setCorsHeaders', () => {
  // We test with different ALLOWED_ORIGINS configurations by re-importing
  // the module with different config mocks.

  describe('with empty allowedOrigins (default-deny)', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it('allows requests with no Origin header (non-browser)', async () => {
      vi.doMock('../../src/config/index.js', () => ({
        config: {
          auth: { allowedOrigins: '', httpHost: '127.0.0.1', apiKey: '', trustProxy: false },
          server: { httpPort: 3000, httpMaxSessions: 100, httpSessionTtlMs: 1800000 },
        },
      }));
      vi.doMock('../../src/utils/logger.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      }));
      vi.doMock('../../src/utils/metrics.js', () => ({
        metrics: { getSnapshot: vi.fn(), recordSuccess: vi.fn(), recordError: vi.fn() },
      }));

      const { isOriginAllowed } = await import('../../src/server/http.js');
      expect(isOriginAllowed(undefined)).toBe(true);
    });

    it('denies requests with Origin when whitelist is empty (default-deny)', async () => {
      vi.doMock('../../src/config/index.js', () => ({
        config: {
          auth: { allowedOrigins: '', httpHost: '127.0.0.1', apiKey: '', trustProxy: false },
          server: { httpPort: 3000, httpMaxSessions: 100, httpSessionTtlMs: 1800000 },
        },
      }));
      vi.doMock('../../src/utils/logger.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      }));
      vi.doMock('../../src/utils/metrics.js', () => ({
        metrics: { getSnapshot: vi.fn(), recordSuccess: vi.fn(), recordError: vi.fn() },
      }));

      const { isOriginAllowed } = await import('../../src/server/http.js');
      expect(isOriginAllowed('https://evil.com')).toBe(false);
    });
  });

  describe('with configured allowedOrigins', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it('allows whitelisted Origin', async () => {
      vi.doMock('../../src/config/index.js', () => ({
        config: {
          auth: { allowedOrigins: 'https://app.example.com,https://admin.example.com', httpHost: '127.0.0.1', apiKey: '', trustProxy: false },
          server: { httpPort: 3000, httpMaxSessions: 100, httpSessionTtlMs: 1800000 },
        },
      }));
      vi.doMock('../../src/utils/logger.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      }));
      vi.doMock('../../src/utils/metrics.js', () => ({
        metrics: { getSnapshot: vi.fn(), recordSuccess: vi.fn(), recordError: vi.fn() },
      }));

      const { isOriginAllowed } = await import('../../src/server/http.js');
      expect(isOriginAllowed('https://app.example.com')).toBe(true);
      expect(isOriginAllowed('https://admin.example.com')).toBe(true);
    });

    it('denies non-whitelisted Origin', async () => {
      vi.doMock('../../src/config/index.js', () => ({
        config: {
          auth: { allowedOrigins: 'https://app.example.com', httpHost: '127.0.0.1', apiKey: '', trustProxy: false },
          server: { httpPort: 3000, httpMaxSessions: 100, httpSessionTtlMs: 1800000 },
        },
      }));
      vi.doMock('../../src/utils/logger.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      }));
      vi.doMock('../../src/utils/metrics.js', () => ({
        metrics: { getSnapshot: vi.fn(), recordSuccess: vi.fn(), recordError: vi.fn() },
      }));

      const { isOriginAllowed } = await import('../../src/server/http.js');
      expect(isOriginAllowed('https://evil.com')).toBe(false);
    });
  });
});
