/**
 * E2E tests using a local mock PingCode API server.
 *
 * These tests exercise the REAL MCP tool handler code paths
 * (no vi.mock) against controlled fixture data, making them
 * repeatable and CI-friendly without external network access.
 *
 * Architecture:
 *   Test → MCP Client → InMemoryTransport → MCP Server
 *                                              ↓
 *                                        Real tool handlers
 *                                              ↓
 *                                        Real API client
 *                                              ↓
 *                                        Mock PingCode HTTP server
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/server/mcp.js';
import { startMockPingCodeServer, FIXTURES, type MockServer } from './mockPingCodeServer.js';

let mockServer: MockServer;
let client: Client;

beforeAll(async () => {
  // Start the mock PingCode API server on a random port
  mockServer = await startMockPingCodeServer();

  // Override the API client's baseUrl to point to the mock server.
  // We do this by setting the env var BEFORE the config module is loaded.
  // Since config is already loaded (singleton), we need to patch the client directly.
  const { apiClient } = await import('../../src/api/client.js');
  // @ts-expect-error: accessing private field for test override
  apiClient.baseUrl = mockServer.url;

  // Create MCP server + client connected via InMemoryTransport
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  client = new Client({ name: 'e2e-test-client', version: '1.0.0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await mockServer?.close();
});

/** Parse JSON from tool result, skipping framing text blocks */
function parseResult(result: { content: unknown }) {
  const content = result.content as Array<{ text: string }>;
  for (const block of content) {
    try {
      return JSON.parse(block.text);
    } catch {
      // skip non-JSON blocks
    }
  }
  throw new Error('No JSON content block found');
}

describe('E2E: list_users', () => {
  it('returns all fixture users', async () => {
    const result = await client.callTool({ name: 'list_users', arguments: {} });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.users).toHaveLength(FIXTURES.USERS.length);
    expect(parsed.users[0].id).toBe('user-alice');
    expect(parsed.total).toBe(3);
  });

  it('keyword filtering works', async () => {
    const result = await client.callTool({ name: 'list_users', arguments: { keyword: 'bob' } });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.users).toHaveLength(1);
    expect(parsed.users[0].name).toBe('bob');
  });
});

describe('E2E: user_work_summary', () => {
  it('returns Alice work summary for Jan 2026', async () => {
    const result = await client.callTool({
      name: 'user_work_summary',
      arguments: {
        user: { id: 'user-alice' },
        time_range: { start: '2026-01-01', end: '2026-01-31' },
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.summary.user.id).toBe('user-alice');
    expect(parsed.summary.total_hours).toBe(7); // 4 + 3
    expect(parsed.data_quality.workloads_count).toBe(2);
    // No truncation → truncation_reasons should be absent
    expect(parsed.data_quality.truncation_reasons).toBeUndefined();
  });

  it('returns NO_DATA for user with no workloads in range', async () => {
    const result = await client.callTool({
      name: 'user_work_summary',
      arguments: {
        user: { id: 'user-carol' },
        time_range: { start: '2026-01-01', end: '2026-01-31' },
      },
    });
    expect(result.isError).toBe(true);
    const parsed = parseResult(result);
    expect(parsed.code).toBe('NO_DATA');
  });

  it('returns USER_NOT_FOUND for nonexistent user name', async () => {
    const result = await client.callTool({
      name: 'user_work_summary',
      arguments: {
        user: { name: 'nonexistent_person_xyz' },
        time_range: { start: '2026-01-01', end: '2026-01-31' },
      },
    });
    expect(result.isError).toBe(true);
    const parsed = parseResult(result);
    expect(parsed.code).toBe('USER_NOT_FOUND');
  });
});

describe('E2E: team_work_summary', () => {
  it('returns team summary for all users in Jan 2026', async () => {
    const result = await client.callTool({
      name: 'team_work_summary',
      arguments: {
        time_range: { start: '2026-01-01', end: '2026-01-31' },
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.summary.total_hours).toBe(10.5); // 4+3+2+1.5
    // All 3 users included: Alice (7h), Bob (3.5h), Carol (0h)
    expect(parsed.summary.members).toHaveLength(3);
    expect(parsed.summary.user_count).toBe(3);
    // data_quality should exist; truncation_reasons should be absent when no truncation
    expect(parsed.data_quality).toBeDefined();
    expect(parsed.data_quality.pagination_truncated).toBe(false);
  });

  it('includes 0-hour users in team summary (P1-2 fix)', async () => {
    const result = await client.callTool({
      name: 'team_work_summary',
      arguments: {
        time_range: { start: '2026-01-01', end: '2026-01-31' },
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    const members = parsed.summary.members;
    const carol = members.find((m: { user: { id: string } }) => m.user.id === 'user-carol');
    expect(carol).toBeDefined();
    expect(carol.total_hours).toBe(0);
    expect(carol.top_projects).toEqual([]);
    expect(carol.top_work_items).toEqual([]);
  });

  it('excludes 0-hour users when include_zero_users=false', async () => {
    const result = await client.callTool({
      name: 'team_work_summary',
      arguments: {
        time_range: { start: '2026-01-01', end: '2026-01-31' },
        include_zero_users: false,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    // Only Alice (7h) and Bob (3.5h) should be included; Carol (0h) excluded
    expect(parsed.summary.members).toHaveLength(2);
    const memberIds = parsed.summary.members.map((m: { user: { id: string } }) => m.user.id);
    expect(memberIds).toContain('user-alice');
    expect(memberIds).toContain('user-bob');
    expect(memberIds).not.toContain('user-carol');
  });

  it('returns team summary for specific user_ids', async () => {
    const result = await client.callTool({
      name: 'team_work_summary',
      arguments: {
        time_range: { start: '2026-01-01', end: '2026-01-31' },
        user_ids: ['user-alice'],
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.summary.total_hours).toBe(7);
  });
});

describe('E2E: get_work_item', () => {
  it('returns work item details', async () => {
    const result = await client.callTool({
      name: 'get_work_item',
      arguments: { id: 'wi-001' },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.work_item.id).toBe('wi-001');
    expect(parsed.work_item.title).toBe('Implement login page');
    expect(parsed.work_item.project.name).toBe('Main Project');
  });

  it('returns NOT_FOUND for nonexistent work item', async () => {
    const result = await client.callTool({
      name: 'get_work_item',
      arguments: { id: 'nonexistent-wi' },
    });
    expect(result.isError).toBe(true);
    const parsed = parseResult(result);
    expect(parsed.code).toBe('NOT_FOUND');
  });
});

describe('E2E: list_workloads', () => {
  it('returns workloads with enriched work item data', async () => {
    const result = await client.callTool({
      name: 'list_workloads',
      arguments: {
        time_range: { start: '2026-01-01', end: '2026-01-31' },
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.workloads.length).toBe(4);
    expect(parsed.total).toBe(4);
    // Verify work item enrichment happened
    const first = parsed.workloads[0];
    expect(first.work_item).toBeDefined();
  });

  it('filters by user via principal_type=user', async () => {
    const result = await client.callTool({
      name: 'list_workloads',
      arguments: {
        principal_type: 'user',
        principal_id: 'user-bob',
        time_range: { start: '2026-01-01', end: '2026-01-31' },
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.workloads.length).toBe(2); // Bob has 2 workloads
    for (const w of parsed.workloads) {
      expect(w.user.id).toBe('user-bob');
    }
  });
});

describe('E2E: builtin tools', () => {
  it('get_metrics returns snapshot', async () => {
    const result = await client.callTool({ name: 'get_metrics', arguments: {} });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.uptime_seconds).toBeDefined();
    expect(parsed.retries).toBeDefined();
  });

  it('get_tool_versions returns version info', async () => {
    const result = await client.callTool({ name: 'get_tool_versions', arguments: {} });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.user_work_summary).toBeDefined();
    expect(parsed.user_work_summary.current).toBe('v1');
  });
});

describe('E2E: structuredContent contract', () => {
  it('all tool responses include structuredContent', async () => {
    const result = await client.callTool({ name: 'list_users', arguments: {} });
    expect(result.structuredContent).toBeDefined();
    const parsed = parseResult(result);
    expect(result.structuredContent).toEqual(parsed);
  });
});
