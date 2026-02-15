/**
 * Mock PingCode API server for repeatable E2E testing.
 *
 * Returns fixture data for all endpoints used by the MCP tools,
 * eliminating external network dependencies.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

// ============ Fixture Data ============

const USERS = [
  { id: 'user-alice', name: 'alice', display_name: 'Alice Zhang', email: 'alice@example.com', department: 'Engineering', job: 'Developer' },
  { id: 'user-bob', name: 'bob', display_name: 'Bob Li', email: 'bob@example.com', department: 'Engineering', job: 'PM' },
  { id: 'user-carol', name: 'carol', display_name: 'Carol Wang', email: 'carol@example.com', department: 'Design', job: 'Designer' },
];

const WORK_ITEMS: Record<string, unknown> = {
  'wi-001': {
    id: 'wi-001',
    identifier: 'PROJ-101',
    title: 'Implement login page',
    project: { id: 'proj-1', identifier: 'PROJ', name: 'Main Project', type: 'agile' },
    assignee: USERS[0],
    state: 'done',
    type: 'story',
  },
  'wi-002': {
    id: 'wi-002',
    identifier: 'PROJ-102',
    title: 'Fix navigation bug',
    project: { id: 'proj-1', identifier: 'PROJ', name: 'Main Project', type: 'agile' },
    assignee: USERS[1],
    state: 'in_progress',
    type: 'bug',
  },
};

// Workloads: all timestamps in Jan 2026
const BASE_TS = 1767225600; // 2026-01-01 00:00:00 UTC
const DAY = 86400;

const RAW_WORKLOADS = [
  {
    id: 'wl-001',
    principal_type: 'work_item',
    principal: { id: 'wi-001', identifier: 'PROJ-101', title: 'Implement login page', type: 'story' },
    type: { id: 'type-dev', name: 'development' },
    duration: 4,
    description: 'Frontend work',
    report_at: BASE_TS + DAY * 2,
    report_by: { id: 'user-alice', name: 'alice', display_name: 'Alice Zhang' },
    created_at: BASE_TS + DAY * 2,
  },
  {
    id: 'wl-002',
    principal_type: 'work_item',
    principal: { id: 'wi-001', identifier: 'PROJ-101', title: 'Implement login page', type: 'story' },
    type: { id: 'type-dev', name: 'development' },
    duration: 3,
    description: 'Backend API',
    report_at: BASE_TS + DAY * 3,
    report_by: { id: 'user-alice', name: 'alice', display_name: 'Alice Zhang' },
    created_at: BASE_TS + DAY * 3,
  },
  {
    id: 'wl-003',
    principal_type: 'work_item',
    principal: { id: 'wi-002', identifier: 'PROJ-102', title: 'Fix navigation bug', type: 'bug' },
    type: { id: 'type-bug', name: 'bugfix' },
    duration: 2,
    description: 'Bug investigation',
    report_at: BASE_TS + DAY * 3,
    report_by: { id: 'user-bob', name: 'bob', display_name: 'Bob Li' },
    created_at: BASE_TS + DAY * 3,
  },
  {
    id: 'wl-004',
    principal_type: 'work_item',
    principal: { id: 'wi-002', identifier: 'PROJ-102', title: 'Fix navigation bug', type: 'bug' },
    type: { id: 'type-bug', name: 'bugfix' },
    duration: 1.5,
    description: 'Fix applied',
    report_at: BASE_TS + DAY * 4,
    report_by: { id: 'user-bob', name: 'bob', display_name: 'Bob Li' },
    created_at: BASE_TS + DAY * 4,
  },
];

// ============ Request Handling ============

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url || '/', `http://${req.headers.host}`);
}

function jsonResponse(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function handleUsers(url: URL, res: ServerResponse): void {
  const pageSize = parseInt(url.searchParams.get('page_size') || '100');
  const pageIndex = parseInt(url.searchParams.get('page_index') || '0');
  const offset = pageIndex * pageSize;
  const slice = USERS.slice(offset, offset + pageSize);

  jsonResponse(res, {
    values: slice,
    total: USERS.length,
    page_index: pageIndex,
    page_size: pageSize,
  });
}

function handleWorkloads(url: URL, res: ServerResponse): void {
  const startAt = parseInt(url.searchParams.get('start_at') || '0');
  const endAt = parseInt(url.searchParams.get('end_at') || String(Date.now()));
  const reportById = url.searchParams.get('report_by_id');
  const pageSize = parseInt(url.searchParams.get('page_size') || '100');
  const pageIndex = parseInt(url.searchParams.get('page_index') || '0');

  let filtered = RAW_WORKLOADS.filter(w => w.report_at >= startAt && w.report_at < endAt);
  if (reportById) {
    filtered = filtered.filter(w => w.report_by.id === reportById);
  }

  const offset = pageIndex * pageSize;
  const slice = filtered.slice(offset, offset + pageSize);

  jsonResponse(res, {
    values: slice,
    total: filtered.length,
    page_index: pageIndex,
    page_size: pageSize,
  });
}

function handleWorkItem(path: string, res: ServerResponse): void {
  const match = path.match(/\/v1\/project\/work_items\/(.+)/);
  if (!match) {
    jsonResponse(res, { error: 'Not found' }, 404);
    return;
  }
  const id = match[1];
  const item = WORK_ITEMS[id];
  if (!item) {
    jsonResponse(res, { error: 'Work item not found' }, 404);
    return;
  }
  jsonResponse(res, item);
}

// ============ Server Lifecycle ============

export interface MockServer {
  url: string;
  port: number;
  server: Server;
  close: () => Promise<void>;
}

export async function startMockPingCodeServer(port = 0): Promise<MockServer> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = parseUrl(req);
      const path = url.pathname;

      // Auth check (mirror real server behavior)
      const authHeader = req.headers['authorization'];
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        jsonResponse(res, { error: 'Unauthorized' }, 401);
        return;
      }

      if (path === '/v1/directory/users') {
        handleUsers(url, res);
      } else if (path === '/v1/workloads') {
        handleWorkloads(url, res);
      } else if (path.startsWith('/v1/project/work_items/')) {
        handleWorkItem(path, res);
      } else {
        jsonResponse(res, { error: 'Not found' }, 404);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://127.0.0.1:${actualPort}`;
      resolve({
        url,
        port: actualPort,
        server,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

// Export fixtures for assertion in tests
export const FIXTURES = {
  USERS,
  WORK_ITEMS,
  RAW_WORKLOADS,
  BASE_TS,
  DAY,
};
