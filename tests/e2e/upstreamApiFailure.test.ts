/**
 * E2E tests verifying that upstream PingCode API failures are reported
 * as UPSTREAM_API_ERROR — NOT silently converted to NO_DATA.
 *
 * Scenario: PingCode returns 401 on /v1/workloads (e.g. token expired).
 * Before the fix, all tools would return NO_DATA / 0-hour results,
 * leading LLMs to incorrect business conclusions ("nobody worked").
 *
 * Architecture:
 *   Test → MCP Client → InMemoryTransport → MCP Server
 *                                              ↓
 *                                        Real tool handlers
 *                                              ↓
 *                                        Real API client (retries disabled for 4xx)
 *                                              ↓
 *                                        Mock PingCode HTTP server (returns 401 on /v1/workloads)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/server/mcp.js';

// ============ Mock Server: workloads always 401, users OK ============

const USERS = [
  { id: 'user-alice', name: 'alice', display_name: 'Alice Zhang', email: 'alice@example.com' },
];

function startFailingMockServer(port = 0): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const path = url.pathname;

      // Users endpoint: works normally (needed for resolveUser)
      if (path === '/v1/directory/users') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          values: USERS,
          total: USERS.length,
          page_index: 0,
          page_size: 100,
        }));
        return;
      }

      // Workloads endpoint: always 401 (simulating expired token)
      if (path === '/v1/workloads') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized', message: 'Token expired' }));
        return;
      }

      // Work items: always 401 too
      if (path.startsWith('/v1/project/work_items/')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized', message: 'Token expired' }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://127.0.0.1:${actualPort}`;
      resolve({
        url,
        server,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

// ============ Tests ============

let mockServer: { url: string; server: Server; close: () => Promise<void> };
let client: Client;
let originalBaseUrl: string;

/** Parse JSON from tool result, skipping framing text blocks */
function parseResult(result: { content: unknown }) {
  const content = result.content as Array<{ text: string }>;
  for (const block of content) {
    try {
      return JSON.parse(block.text);
    } catch {
      // skip non-JSON blocks (framing)
    }
  }
  throw new Error('No JSON content block found');
}

beforeAll(async () => {
  mockServer = await startFailingMockServer();

  // Override API client baseUrl to point to our failing mock server
  const { apiClient } = await import('../../src/api/client.js');
  // @ts-expect-error: accessing private field for test override
  originalBaseUrl = apiClient.baseUrl;
  // @ts-expect-error: accessing private field for test override
  apiClient.baseUrl = mockServer.url;

  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  client = new Client({ name: 'api-failure-test', version: '1.0.0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  // Restore original baseUrl so other test files are not affected
  const { apiClient } = await import('../../src/api/client.js');
  // @ts-expect-error: accessing private field for test override
  apiClient.baseUrl = originalBaseUrl;

  await mockServer?.close();
});

describe('Upstream API failure → UPSTREAM_API_ERROR (not NO_DATA)', () => {
  it('user_work_summary returns UPSTREAM_API_ERROR when workloads API returns 401', async () => {
    const result = await client.callTool({
      name: 'user_work_summary',
      arguments: {
        user: { id: 'user-alice' },
        time_range: { start: '2026-01-01', end: '2026-01-31' },
      },
    });

    // Must be marked as error
    expect(result.isError).toBe(true);

    const parsed = parseResult(result);

    // CRITICAL: must NOT be NO_DATA — that would mislead the LLM
    expect(parsed.code).not.toBe('NO_DATA');
    // Should be UPSTREAM_API_ERROR
    expect(parsed.code).toBe('UPSTREAM_API_ERROR');
    // Error message should hint at the API failure
    expect(parsed.error).toMatch(/API|401|请求失败/i);
  });

  it('team_work_summary returns UPSTREAM_API_ERROR when workloads API returns 401', async () => {
    const result = await client.callTool({
      name: 'team_work_summary',
      arguments: {
        time_range: { start: '2026-01-01', end: '2026-01-31' },
        include_zero_users: false,
      },
    });

    expect(result.isError).toBe(true);

    const parsed = parseResult(result);
    expect(parsed.code).not.toBe('NO_DATA');
    expect(parsed.code).toBe('UPSTREAM_API_ERROR');
  });

  it('list_workloads returns UPSTREAM_API_ERROR when workloads API returns 401', async () => {
    const result = await client.callTool({
      name: 'list_workloads',
      arguments: {
        time_range: { start: '2026-01-01', end: '2026-01-31' },
      },
    });

    expect(result.isError).toBe(true);

    const parsed = parseResult(result);
    expect(parsed.code).not.toBe('NO_DATA');
    expect(parsed.code).toBe('UPSTREAM_API_ERROR');
  });

  it('team_work_summary with include_zero_users=true still reports API error (not 0-hour for all)', async () => {
    const result = await client.callTool({
      name: 'team_work_summary',
      arguments: {
        time_range: { start: '2026-01-01', end: '2026-01-31' },
        include_zero_users: true,
      },
    });

    // When include_zero_users=true, the old code would return a "success"
    // with everyone at 0 hours — equally misleading.  Now it should
    // report the upstream error.
    expect(result.isError).toBe(true);

    const parsed = parseResult(result);
    expect(parsed.code).toBe('UPSTREAM_API_ERROR');
  });
});
