/**
 * Tests for Issue 2: TOKEN_MODE=user integration
 *
 * Tests user-mode scoping through the MCP server via InMemoryTransport.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/server/mcp.js';
import { startMockPingCodeServer, type MockServer } from './mockPingCodeServer.js';
import type { UserContext } from '../../src/auth/userContext.js';

let mockServer: MockServer;
let userClient: Client;
let enterpriseClient: Client;

beforeAll(async () => {
  mockServer = await startMockPingCodeServer();
  const { apiClient } = await import('../../src/api/client.js');
  // @ts-expect-error: accessing private field for test override
  apiClient.baseUrl = mockServer.url;

  // Create user-mode MCP server
  const userCtx: UserContext = { userId: 'user-alice', tokenMode: 'user' };
  const userServer = createMcpServer(userCtx);
  const [userClientTransport, userServerTransport] = InMemoryTransport.createLinkedPair();
  await userServer.connect(userServerTransport);
  userClient = new Client({ name: 'user-mode-test', version: '1.0.0' });
  await userClient.connect(userClientTransport);

  // Create enterprise-mode MCP server (default)
  const enterpriseServer = createMcpServer();
  const [entClientTransport, entServerTransport] = InMemoryTransport.createLinkedPair();
  await enterpriseServer.connect(entServerTransport);
  enterpriseClient = new Client({ name: 'enterprise-mode-test', version: '1.0.0' });
  await enterpriseClient.connect(entClientTransport);
});

afterAll(async () => {
  await mockServer?.close();
});

/** Parse JSON from tool result */
function parseResult(result: { content: unknown }) {
  const content = result.content as Array<{ text: string }>;
  for (const block of content) {
    try {
      return JSON.parse(block.text);
    } catch {
      // skip
    }
  }
  throw new Error('No JSON block found');
}

describe('TOKEN_MODE=user via MCP', () => {
  it('user_work_summary is scoped to the authenticated user', async () => {
    // Try querying another user — should get rewritten to user-alice
    const result = await userClient.callTool({
      name: 'user_work_summary',
      arguments: {
        user: { id: 'user-bob' },
        time_range: { start: '2026-01-01', end: '2026-01-31' },
      },
    });
    // Should return Alice's data, not Bob's, because scope enforcer rewrites user.id
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.summary.user.id).toBe('user-alice');
  });

  it('team_work_summary is restricted to the authenticated user', async () => {
    const result = await userClient.callTool({
      name: 'team_work_summary',
      arguments: {
        time_range: { start: '2026-01-01', end: '2026-01-31' },
        user_ids: ['user-alice', 'user-bob'],
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    // Should only contain user-alice, not bob
    expect(parsed.summary.members).toHaveLength(1);
    expect(parsed.summary.members[0].user.id).toBe('user-alice');
  });

  it('list_users works without restriction in user mode', async () => {
    const result = await userClient.callTool({
      name: 'list_users',
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    // All users should be visible
    expect(parsed.users.length).toBeGreaterThan(1);
  });

  it('enterprise mode does not restrict queries', async () => {
    const result = await enterpriseClient.callTool({
      name: 'team_work_summary',
      arguments: {
        time_range: { start: '2026-01-01', end: '2026-01-31' },
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    // Enterprise mode: all users
    expect(parsed.summary.members.length).toBeGreaterThan(1);
  });
});
