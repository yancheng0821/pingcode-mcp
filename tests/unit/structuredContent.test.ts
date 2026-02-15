import { describe, it, expect, vi, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, isBusinessError } from '../../src/server/mcp.js';

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
    // Find the JSON block (skip framing text)
    const jsonBlock = content.find(b => { try { JSON.parse(b.text); return true; } catch { return false; } });
    expect(jsonBlock).toBeDefined();
    const textParsed = JSON.parse(jsonBlock!.text);
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
    // The JSON data block (content[1] for versioned tools) has annotations
    const annotatedBlock = content.find(b => b.annotations?.audience);
    expect(annotatedBlock).toBeDefined();
    expect(annotatedBlock!.annotations!.audience).toContain('assistant');
  });
});

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
