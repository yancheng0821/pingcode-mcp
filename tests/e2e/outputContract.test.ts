/**
 * Contract 4: Output schema snapshot stability
 *
 * Verifies the structural contract of tool response bodies.
 * Uses the real MCP server + InMemoryTransport with mocked API
 * to assert that output shapes match the documented interfaces.
 *
 * This is NOT a value-level snapshot — it validates field presence and types,
 * ensuring the output contract doesn't silently break.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/server/mcp.js';
import { startMockPingCodeServer, type MockServer } from './mockPingCodeServer.js';

let mockServer: MockServer;
let client: Client;

beforeAll(async () => {
  mockServer = await startMockPingCodeServer();
  const { apiClient } = await import('../../src/api/client.js');
  // @ts-expect-error: accessing private field for test override
  apiClient.baseUrl = mockServer.url;

  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'contract-test-client', version: '1.0.0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await mockServer?.close();
});

/** Parse the JSON text from a tool result (skip framing blocks) */
function parseResult(result: { content: unknown }) {
  const content = result.content as Array<{ text: string }>;
  for (const block of content) {
    try {
      return JSON.parse(block.text);
    } catch {
      // skip non-JSON blocks (e.g. framing text)
    }
  }
  throw new Error('No JSON content block found');
}

describe('Output contract: team_work_summary', () => {
  it('has required top-level fields: summary, details, data_quality', async () => {
    const result = await client.callTool({
      name: 'team_work_summary',
      arguments: { time_range: { start: '2026-01-01', end: '2026-01-31' } },
    });
    const parsed = parseResult(result);

    expect(parsed).toHaveProperty('summary');
    expect(parsed).toHaveProperty('details');
    expect(parsed).toHaveProperty('data_quality');
  });

  it('summary has correct structure', async () => {
    const result = await client.callTool({
      name: 'team_work_summary',
      arguments: { time_range: { start: '2026-01-01', end: '2026-01-31' } },
    });
    const { summary } = parseResult(result);

    // Required fields
    expect(summary).toHaveProperty('time_range');
    expect(summary.time_range).toHaveProperty('start_at');
    expect(summary.time_range).toHaveProperty('end_at');
    expect(typeof summary.time_range.start_at).toBe('number');
    expect(typeof summary.time_range.end_at).toBe('number');

    expect(typeof summary.total_hours).toBe('number');
    expect(typeof summary.user_count).toBe('number');
    expect(Array.isArray(summary.members)).toBe(true);

    // Member structure
    const member = summary.members[0];
    expect(member).toHaveProperty('user');
    expect(typeof member.user.id).toBe('string');
    expect(typeof member.user.name).toBe('string');
    expect(typeof member.user.display_name).toBe('string');
    expect(typeof member.total_hours).toBe('number');
  });

  it('details array has correct item structure', async () => {
    const result = await client.callTool({
      name: 'team_work_summary',
      arguments: { time_range: { start: '2026-01-01', end: '2026-01-31' } },
    });
    const { details } = parseResult(result);

    expect(Array.isArray(details)).toBe(true);
    expect(details.length).toBeGreaterThan(0);

    const detail = details[0];
    expect(typeof detail.date).toBe('string');
    expect(typeof detail.workload_id).toBe('string');
    expect(typeof detail.hours).toBe('number');
    expect(detail).toHaveProperty('user');
    expect(typeof detail.user.id).toBe('string');
    // work_item can be null or object
    if (detail.work_item !== null) {
      expect(typeof detail.work_item.id).toBe('string');
      expect(typeof detail.work_item.identifier).toBe('string');
      expect(typeof detail.work_item.title).toBe('string');
    }
  });

  it('data_quality has all required fields with correct types', async () => {
    const result = await client.callTool({
      name: 'team_work_summary',
      arguments: { time_range: { start: '2026-01-01', end: '2026-01-31' } },
    });
    const { data_quality } = parseResult(result);

    expect(typeof data_quality.workloads_count).toBe('number');
    expect(typeof data_quality.missing_work_item_count).toBe('number');
    expect(typeof data_quality.unknown_user_matches).toBe('number');
    expect(typeof data_quality.time_sliced).toBe('boolean');
    expect(typeof data_quality.pagination_truncated).toBe('boolean');
    expect(typeof data_quality.details_truncated).toBe('boolean');
  });
});

describe('Output contract: user_work_summary', () => {
  it('success response has summary, details, data_quality', async () => {
    const result = await client.callTool({
      name: 'user_work_summary',
      arguments: {
        user: { id: 'user-alice' },
        time_range: { start: '2026-01-01', end: '2026-01-31' },
      },
    });
    const parsed = parseResult(result);

    expect(parsed).toHaveProperty('summary');
    expect(parsed).toHaveProperty('details');
    expect(parsed).toHaveProperty('data_quality');

    // summary fields
    const { summary } = parsed;
    expect(summary).toHaveProperty('user');
    expect(typeof summary.user.id).toBe('string');
    expect(typeof summary.user.name).toBe('string');
    expect(typeof summary.user.display_name).toBe('string');
    expect(summary).toHaveProperty('time_range');
    expect(typeof summary.total_hours).toBe('number');
    expect(Array.isArray(summary.by_project)).toBe(true);
    expect(Array.isArray(summary.by_work_item)).toBe(true);
  });

  it('data_quality has user-specific fields', async () => {
    const result = await client.callTool({
      name: 'user_work_summary',
      arguments: {
        user: { id: 'user-alice' },
        time_range: { start: '2026-01-01', end: '2026-01-31' },
      },
    });
    const { data_quality } = parseResult(result);

    expect(typeof data_quality.workloads_count).toBe('number');
    expect(typeof data_quality.missing_work_item_count).toBe('number');
    expect(typeof data_quality.unknown_user_match).toBe('boolean');
    expect(typeof data_quality.time_sliced).toBe('boolean');
    expect(typeof data_quality.pagination_truncated).toBe('boolean');
    expect(typeof data_quality.details_truncated).toBe('boolean');
  });

  it('error response has error and code fields', async () => {
    const result = await client.callTool({
      name: 'user_work_summary',
      arguments: {
        user: { name: 'nonexistent_xyz_999' },
        time_range: { start: '2026-01-01', end: '2026-01-31' },
      },
    });
    expect(result.isError).toBe(true);
    const parsed = parseResult(result);
    expect(typeof parsed.error).toBe('string');
    expect(typeof parsed.code).toBe('string');
  });
});

describe('Output contract: list_users', () => {
  it('has users array and total count', async () => {
    const result = await client.callTool({ name: 'list_users', arguments: {} });
    const parsed = parseResult(result);

    expect(Array.isArray(parsed.users)).toBe(true);
    expect(typeof parsed.total).toBe('number');

    const user = parsed.users[0];
    expect(typeof user.id).toBe('string');
    expect(typeof user.name).toBe('string');
    expect(typeof user.display_name).toBe('string');
  });
});

describe('Output contract: list_workloads', () => {
  it('has workloads array, total, and data_quality', async () => {
    const result = await client.callTool({
      name: 'list_workloads',
      arguments: { time_range: { start: '2026-01-01', end: '2026-01-31' } },
    });
    const parsed = parseResult(result);

    expect(Array.isArray(parsed.workloads)).toBe(true);
    expect(typeof parsed.total).toBe('number');
    expect(parsed).toHaveProperty('data_quality');

    const wl = parsed.workloads[0];
    expect(typeof wl.id).toBe('string');
    expect(typeof wl.hours).toBe('number');
    expect(typeof wl.date).toBe('string');
    expect(wl).toHaveProperty('user');
  });

  it('data_quality has required fields', async () => {
    const result = await client.callTool({
      name: 'list_workloads',
      arguments: { time_range: { start: '2026-01-01', end: '2026-01-31' } },
    });
    const { data_quality } = parseResult(result);

    expect(typeof data_quality.time_sliced).toBe('boolean');
    expect(typeof data_quality.pagination_truncated).toBe('boolean');
    expect(typeof data_quality.result_truncated).toBe('boolean');
  });
});

describe('Output contract: get_work_item', () => {
  it('success response has work_item with expected fields', async () => {
    const result = await client.callTool({
      name: 'get_work_item',
      arguments: { id: 'wi-001' },
    });
    const parsed = parseResult(result);

    expect(parsed).toHaveProperty('work_item');
    const wi = parsed.work_item;
    expect(typeof wi.id).toBe('string');
    expect(typeof wi.identifier).toBe('string');
    expect(typeof wi.title).toBe('string');
    expect(wi).toHaveProperty('project');
    expect(typeof wi.project.name).toBe('string');
  });

  it('error response for missing item has error + code', async () => {
    const result = await client.callTool({
      name: 'get_work_item',
      arguments: { id: 'nonexistent-item-xyz' },
    });
    expect(result.isError).toBe(true);
    const parsed = parseResult(result);
    expect(typeof parsed.error).toBe('string');
    expect(typeof parsed.code).toBe('string');
  });
});

describe('Output contract: builtin tools', () => {
  it('get_metrics has uptime, requests, cache, retries, data_quality sections', async () => {
    const result = await client.callTool({ name: 'get_metrics', arguments: {} });
    const parsed = parseResult(result);

    expect(typeof parsed.uptime_seconds).toBe('number');
    expect(parsed).toHaveProperty('requests');
    expect(typeof parsed.requests.total).toBe('number');
    expect(typeof parsed.requests.errors).toBe('number');
    expect(parsed).toHaveProperty('cache');
    expect(typeof parsed.cache.hits).toBe('number');
    expect(parsed).toHaveProperty('retries');
    expect(typeof parsed.retries.total_retries).toBe('number');
    expect(parsed).toHaveProperty('data_quality');
    expect(typeof parsed.data_quality.total_responses).toBe('number');
    expect(typeof parsed.data_quality.truncation_rate).toBe('number');
  });
});
