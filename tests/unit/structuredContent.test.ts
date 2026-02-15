import { describe, it, expect, vi, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/server/mcp.js';

// Mock the API client
vi.mock('../../src/api/client.js', () => {
  const mockRequest = vi.fn().mockImplementation(async (endpoint: string) => {
    if (endpoint.includes('/users')) {
      return {
        total_count: 1,
        values: [
          {
            id: 'user-1',
            name: 'alice',
            display_name: 'Alice Zhang',
            email: 'alice@example.com',
          },
        ],
      };
    }
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

describe('MCP structuredContent & annotations', () => {
  let client: Client;

  beforeAll(async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  it('normal tool response has structuredContent matching parsed text', async () => {
    const result = await client.callTool({
      name: 'list_users',
      arguments: {},
    });
    expect(result.structuredContent).toBeDefined();
    const content = result.content as Array<{ type: string; text: string }>;
    const textParsed = JSON.parse(content[0].text);
    // structuredContent should match the payload
    expect(result.structuredContent).toEqual(textParsed);
  });

  it('business error response has structuredContent with error/code', async () => {
    const result = await client.callTool({
      name: 'get_work_item',
      arguments: { id: 'nonexistent-id' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeDefined();
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.error).toBeDefined();
    expect(sc.code).toBeDefined();
  });

  it('builtin tool has structuredContent', async () => {
    const result = await client.callTool({
      name: 'get_metrics',
      arguments: {},
    });
    expect(result.structuredContent).toBeDefined();
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.uptime_seconds).toBeDefined();
  });

  it('versioned tool content has annotations.audience', async () => {
    const result = await client.callTool({
      name: 'list_users',
      arguments: {},
    });
    const content = result.content as Array<{ type: string; text: string; annotations?: { audience?: string[] } }>;
    expect(content[0].annotations).toBeDefined();
    expect(content[0].annotations!.audience).toContain('assistant');
  });
});
