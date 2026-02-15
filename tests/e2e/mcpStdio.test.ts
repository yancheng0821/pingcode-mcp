import { describe, it, expect, vi, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/server/mcp.js';

// Mock the API client to return fixture data instead of making real HTTP requests
vi.mock('../../src/api/client.js', () => {
  const mockRequest = vi.fn().mockImplementation(async (endpoint: string) => {
    if (endpoint.includes('/users')) {
      return {
        total_count: 2,
        values: [
          {
            id: 'user-1',
            name: 'alice',
            display_name: 'Alice Zhang',
            email: 'alice@example.com',
          },
          {
            id: 'user-2',
            name: 'bob',
            display_name: 'Bob Li',
            email: 'bob@example.com',
          },
        ],
      };
    }
    // Default: return empty
    return { total_count: 0, values: [] };
  });

  return {
    PingCodeApiClient: vi.fn().mockImplementation(() => ({
      request: mockRequest,
    })),
    PingCodeApiError: class PingCodeApiError extends Error {
      status: number;
      details?: string;
      constructor(status: number, message: string, details?: string) {
        super(message);
        this.name = 'PingCodeApiError';
        this.status = status;
        this.details = details;
      }
    },
    apiClient: { request: mockRequest },
  };
});

describe('MCP Server e2e (InMemoryTransport)', () => {
  let client: Client;

  beforeAll(async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  it('listTools returns 5+ tools', async () => {
    const result = await client.listTools();
    // 5 versioned tools (each with alias + explicit version) + 2 builtins = 12
    expect(result.tools.length).toBeGreaterThanOrEqual(5);
  });

  it('callTool(list_users) returns user data', async () => {
    const result = await client.callTool({
      name: 'list_users',
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    // content[0] is framing text, content[1] is JSON for versioned tools
    expect(content.length).toBeGreaterThanOrEqual(1);
    const jsonBlock = content.find(b => { try { JSON.parse(b.text); return true; } catch { return false; } });
    expect(jsonBlock).toBeDefined();
    const parsed = JSON.parse(jsonBlock!.text);
    expect(parsed.users).toBeDefined();
    expect(parsed.users.length).toBeGreaterThan(0);
    expect(parsed.users[0].id).toBe('user-1');
  });

  it('callTool with unknown tool returns isError', async () => {
    const result = await client.callTool({
      name: 'nonexistent_tool',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.error).toContain('Unknown tool');
  });

  it('callTool(get_work_item) with mock returning empty yields business error', async () => {
    // The mock returns { total_count: 0, values: [] } for non-user endpoints
    // get_work_item calls workItemService which calls apiClient
    // We expect a NOT_FOUND or similar error
    const result = await client.callTool({
      name: 'get_work_item',
      arguments: { id: 'nonexistent-id' },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const jsonBlock = content.find(b => { try { JSON.parse(b.text); return true; } catch { return false; } });
    expect(jsonBlock).toBeDefined();
    const parsed = JSON.parse(jsonBlock!.text);
    expect(parsed.error).toBeDefined();
    expect(parsed.code).toBeDefined();
  });
});
