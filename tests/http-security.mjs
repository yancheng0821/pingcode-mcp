#!/usr/bin/env node
/**
 * PingCode MCP HTTP 安全与部署测试
 *
 * 独立于回归测试。使用本地 Mock 服务器，不依赖 PingCode 真实 API。
 *
 * 运行: node tests/http-security.mjs
 *       npm run test:http
 *
 * 覆盖:
 * - SEC1: Origin 验证（防 DNS rebinding）
 * - SEC2: CORS 头
 * - SEC3: API Key 鉴权
 * - SEC4: 公开端点（/health, /metrics, 404）
 * - SEC5: API 客户端超时与 429 Retry-After
 * - SEC6: Session 管理（上限、TTL、DELETE）
 * - SEC7: 请求解析与部署配置（非法 JSON、绑定地址、CORS 头完整性）
 */

import { createServer } from 'node:http';

// ── 测试环境（必须在 import dist/ 之前设置） ──────────────────

const TEST_HTTP_PORT = 19876;
const MOCK_API_PORT  = 19877;
const TEST_API_KEY   = 'test-api-key-12345';

process.env.PINGCODE_TOKEN     = 'mock-token';
process.env.PINGCODE_BASE_URL  = `http://127.0.0.1:${MOCK_API_PORT}`;
process.env.TRANSPORT_MODE     = 'http';
process.env.MCP_API_KEY        = TEST_API_KEY;
process.env.HTTP_PORT          = String(TEST_HTTP_PORT);
process.env.HTTP_HOST          = '127.0.0.1';
process.env.ALLOWED_ORIGINS    = 'https://trusted.example.com,https://other.example.com';
process.env.REQUEST_TIMEOUT    = '300';
process.env.HTTP_MAX_SESSIONS  = '5';
process.env.HTTP_SESSION_TTL_MS = '3000';
process.env.LOG_LEVEL          = 'error';

// ── 测试框架 ────────────────────────────────────────────────

const results = { passed: 0, failed: 0, tests: [] };

function test(name, fn) { return { name, fn }; }

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function runTest(testCase) {
  const start = Date.now();
  try {
    await testCase.fn();
    const ms = Date.now() - start;
    results.passed++;
    results.tests.push({ name: testCase.name, status: 'PASS', duration: ms });
    console.log(`  ✅ ${testCase.name} (${ms}ms)`);
  } catch (err) {
    const ms = Date.now() - start;
    results.failed++;
    results.tests.push({ name: testCase.name, status: 'FAIL', duration: ms, error: err.message });
    console.log(`  ❌ ${testCase.name} (${ms}ms)`);
    console.log(`     Error: ${err.message}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const BASE = `http://127.0.0.1:${TEST_HTTP_PORT}`;

// ── Mock PingCode API 服务器 ────────────────────────────────

const mockLog = [];

const mockServer = createServer((req, res) => {
  mockLog.push({ path: req.url, ts: Date.now() });

  // /api/slow — 远超 timeout 才响应（测试 AbortController）
  if (req.url?.startsWith('/api/slow')) {
    const timer = setTimeout(() => {
      if (!res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"data":"slow"}');
      }
    }, 60_000);
    req.on('close', () => clearTimeout(timer));
    return;
  }

  // /api/rate-limited — 首次 429 + Retry-After:1，后续 200
  if (req.url?.startsWith('/api/rate-limited')) {
    const hits = mockLog.filter(r => r.path?.startsWith('/api/rate-limited')).length;
    if (hits <= 1) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '1',
      });
      res.end('{"error":"rate limited"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"data":"ok"}');
    return;
  }

  // 其他路径 — 立即 200
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"data":"ok"}');
});

// ── SEC1: Origin 验证 ─────────────────────────────────────

const sec1Tests = [
  test('SEC1.1 - 受信 Origin 放行', async () => {
    const res = await fetch(`${BASE}/health`, {
      headers: { 'Origin': 'https://trusted.example.com' },
    });
    assert(res.status === 200, `期望 200，实际 ${res.status}`);
  }),

  test('SEC1.2 - 不受信 Origin 拒绝 (403)', async () => {
    const res = await fetch(`${BASE}/health`, {
      headers: { 'Origin': 'https://evil.example.com' },
    });
    assert(res.status === 403, `期望 403，实际 ${res.status}`);
  }),

  test('SEC1.3 - 无 Origin（非浏览器）放行', async () => {
    const res = await fetch(`${BASE}/health`);
    assert(res.status === 200, `期望 200，实际 ${res.status}`);
  }),
];

// ── SEC2: CORS 头 ─────────────────────────────────────────

const sec2Tests = [
  test('SEC2.1 - 受信 Origin 反射到 Access-Control-Allow-Origin', async () => {
    const origin = 'https://trusted.example.com';
    const res = await fetch(`${BASE}/health`, {
      headers: { 'Origin': origin },
    });
    const acao = res.headers.get('access-control-allow-origin');
    assert(acao === origin, `ACAO 应为 ${origin}，实际: ${acao}`);
  }),

  test('SEC2.2 - 无 Origin 时不设置 ACAO（非浏览器无需）', async () => {
    const res = await fetch(`${BASE}/health`);
    const acao = res.headers.get('access-control-allow-origin');
    assert(!acao, `不应设置 ACAO，实际: ${acao}`);
  }),

  test('SEC2.3 - OPTIONS 预检返回 204 + 完整 CORS 头', async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'OPTIONS',
      headers: { 'Origin': 'https://trusted.example.com' },
    });
    assert(res.status === 204, `期望 204，实际 ${res.status}`);

    const methods = res.headers.get('access-control-allow-methods');
    assert(methods?.includes('POST'), `Allow-Methods 应包含 POST: ${methods}`);
    assert(methods?.includes('DELETE'), `Allow-Methods 应包含 DELETE: ${methods}`);

    const hdrs = res.headers.get('access-control-allow-headers');
    assert(hdrs?.includes('X-API-Key'), `Allow-Headers 应包含 X-API-Key: ${hdrs}`);
    assert(hdrs?.includes('MCP-Protocol-Version'), `Allow-Headers 应包含 MCP-Protocol-Version: ${hdrs}`);

    const expose = res.headers.get('access-control-expose-headers');
    assert(expose?.includes('Mcp-Session-Id'), `Expose-Headers 应包含 Mcp-Session-Id: ${expose}`);
  }),
];

// ── SEC3: API Key 鉴权 ───────────────────────────────────

const sec3Tests = [
  test('SEC3.1 - 无 Key 访问 /mcp 返回 401', async () => {
    const res = await fetch(`${BASE}/mcp`, { method: 'POST' });
    assert(res.status === 401, `期望 401，实际 ${res.status}`);
  }),

  test('SEC3.2 - 错误 Key 返回 401', async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer wrong-key-999' },
    });
    assert(res.status === 401, `期望 401，实际 ${res.status}`);
  }),

  test('SEC3.3 - Bearer 正确 Key 通过鉴权（不返回 401/403）', async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert(
      res.status !== 401 && res.status !== 403,
      `鉴权不应失败，实际 status: ${res.status}`,
    );
  }),

  test('SEC3.4 - X-API-Key 正确 Key 通过鉴权（不返回 401/403）', async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'X-API-Key': TEST_API_KEY,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert(
      res.status !== 401 && res.status !== 403,
      `鉴权不应失败，实际 status: ${res.status}`,
    );
  }),
];

// ── SEC4: 公开端点 ───────────────────────────────────────

const sec4Tests = [
  test('SEC4.1 - /health 无需鉴权返回 200', async () => {
    const res = await fetch(`${BASE}/health`);
    assert(res.status === 200, `期望 200，实际 ${res.status}`);
    const body = await res.json();
    assert(body.status === 'ok', `期望 status=ok，实际: ${body.status}`);
    assert(body.service === 'pingcode-mcp', `期望 service=pingcode-mcp，实际: ${body.service}`);
  }),

  test('SEC4.2 - /metrics 无需鉴权返回指标快照', async () => {
    const res = await fetch(`${BASE}/metrics`);
    assert(res.status === 200, `期望 200，实际 ${res.status}`);
    const body = await res.json();
    assert('uptime_seconds' in body, '应包含 uptime_seconds 字段');
    assert('requests' in body, '应包含 requests 字段');
  }),

  test('SEC4.3 - 未知路径无鉴权返回 401（不泄露路径信息）', async () => {
    const res = await fetch(`${BASE}/unknown-path`);
    assert(res.status === 401, `期望 401，实际 ${res.status}`);
  }),

  test('SEC4.4 - 未知路径有鉴权返回 404', async () => {
    const res = await fetch(`${BASE}/unknown-path`, {
      headers: { 'Authorization': `Bearer ${TEST_API_KEY}` },
    });
    assert(res.status === 404, `期望 404，实际 ${res.status}`);
  }),
];

// ── SEC5: API 客户端超时与 Retry-After ───────────────────

const sec5Tests = [
  test('SEC5.1 - 慢请求触发 AbortController 超时', async () => {
    const { PingCodeApiClient } = await import('../dist/api/client.js');
    const client = new PingCodeApiClient();

    try {
      await client.request('/api/slow');
      assert(false, '应抛出超时错误');
    } catch (err) {
      assert(
        err.message.includes('timed out'),
        `错误消息应包含 "timed out"，实际: ${err.message}`,
      );
    }
  }),

  test('SEC5.2 - 429 Retry-After 头被尊重', async () => {
    // 重置 mock 日志（隔离本测试的请求记录）
    mockLog.length = 0;

    const { PingCodeApiClient } = await import('../dist/api/client.js');
    const client = new PingCodeApiClient();

    const result = await client.request('/api/rate-limited');
    assert(result.data === 'ok', `期望 data=ok，实际: ${JSON.stringify(result)}`);

    // 验证至少重试了一次
    const hits = mockLog.filter(r => r.path?.startsWith('/api/rate-limited'));
    assert(hits.length >= 2, `应至少重试 1 次，实际请求 ${hits.length} 次`);

    // 验证两次请求间隔 ≥ Retry-After 指定的 1 秒（允许 200ms 容差）
    const retryDelay = hits[1].ts - hits[0].ts;
    assert(retryDelay >= 800, `Retry-After 延迟过短: ${retryDelay}ms（期望 ≥ 800ms）`);
  }),
];

// ── SEC6: Session 管理 ──────────────────────────────────

// MCP 协议要求客户端 Accept SSE 格式
const MCP_HEADERS = {
  'Authorization': `Bearer ${TEST_API_KEY}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

function mcpInitBody(id, clientName) {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'initialize',
    id,
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: clientName, version: '1.0.0' },
    },
  });
}

const sec6Tests = [
  test('SEC6.1 - 超过 session 上限返回 503', async () => {
    const sessions = [];

    // 持续创建 session 直到触发上限
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: mcpInitBody(1000 + i, `limit-${i}`),
      });

      if (res.status === 503) {
        const body = await res.json();
        assert(body.message.includes('Too many'), `503 消息应含 "Too many": ${body.message}`);
        assert(sessions.length >= 1, `应至少创建 1 个 session 才触发上限`);

        // 清理已创建的 session
        for (const sid of sessions) {
          await fetch(`${BASE}/mcp`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${TEST_API_KEY}`, 'Mcp-Session-Id': sid },
          });
        }
        return;
      }

      await res.text();
      const sid = res.headers.get('mcp-session-id');
      if (sid && !sessions.includes(sid)) sessions.push(sid);
    }

    // 清理
    for (const sid of sessions) {
      await fetch(`${BASE}/mcp`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${TEST_API_KEY}`, 'Mcp-Session-Id': sid },
      });
    }
    assert(false, '创建 20 个 session 均未触发 503');
  }),

  test('SEC6.2 - session TTL 到期后自动清理释放名额', async () => {
    const sessions = [];

    // 填满所有 session 名额
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: mcpInitBody(2000 + i, `ttl-${i}`),
      });

      if (res.status === 503) break;
      await res.text();
      const sid = res.headers.get('mcp-session-id');
      if (sid && !sessions.includes(sid)) sessions.push(sid);
    }

    // 确认已满
    const full = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: mcpInitBody(2099, 'ttl-full'),
    });
    await full.text();
    assert(full.status === 503, `应已满返回 503，实际: ${full.status}`);

    // 等待 TTL 到期 + 清理间隔（TTL=3s, cleanup~1.5s, 留余量）
    await sleep(5500);

    // TTL 到期后应能创建新 session
    const afterExpiry = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: mcpInitBody(2100, 'ttl-after'),
    });

    assert(
      afterExpiry.status !== 503,
      `TTL 到期后应能创建新 session，实际: ${afterExpiry.status}`
    );

    // 清理
    const newSid = afterExpiry.headers.get('mcp-session-id');
    if (newSid) {
      await fetch(`${BASE}/mcp`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${TEST_API_KEY}`, 'Mcp-Session-Id': newSid },
      });
    }
  }),

  test('SEC6.3 - DELETE 终止 session 返回 200', async () => {
    // 创建 session
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: mcpInitBody(3000, 'delete-test'),
    });
    await res.text();
    const sessionId = res.headers.get('mcp-session-id');
    assert(sessionId, '应返回 Mcp-Session-Id');

    // 删除 session
    const del = await fetch(`${BASE}/mcp`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${TEST_API_KEY}`, 'Mcp-Session-Id': sessionId },
    });
    assert(del.status === 200, `DELETE 应返回 200，实际: ${del.status}`);

    // 重复删除应返回 404
    const del2 = await fetch(`${BASE}/mcp`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${TEST_API_KEY}`, 'Mcp-Session-Id': sessionId },
    });
    assert(del2.status === 404, `重复 DELETE 应返回 404，实际: ${del2.status}`);
  }),
];

// ── SEC7: 请求解析与部署配置 ─────────────────────────────

const sec7Tests = [
  test('SEC7.1 - 非法 JSON 请求体返回 400', async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: '{invalid json!!!',
    });
    assert(res.status === 400, `期望 400，实际 ${res.status}`);
    const body = await res.json();
    assert(body.error === 'Bad Request', `error 应为 "Bad Request"，实际: ${body.error}`);
    assert(body.message.includes('Invalid JSON'), `message 应含 "Invalid JSON"，实际: ${body.message}`);
  }),

  test('SEC7.2 - 服务默认绑定 127.0.0.1 且日志走 logger', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __filename = fileURLToPath(import.meta.url);
    const projectRoot = path.dirname(path.dirname(__filename));

    const httpCode = fs.readFileSync(path.join(projectRoot, 'src/server/http.ts'), 'utf-8');
    assert(
      httpCode.includes("|| '127.0.0.1'"),
      'http.ts 应默认绑定 127.0.0.1'
    );
    assert(
      !httpCode.includes('console.log'),
      'http.ts 不应使用 console.log（应使用 logger）'
    );
  }),

  test('SEC7.3 - CORS Allow-Headers 包含鉴权与协议所需头', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __filename = fileURLToPath(import.meta.url);
    const projectRoot = path.dirname(path.dirname(__filename));

    const httpCode = fs.readFileSync(path.join(projectRoot, 'src/server/http.ts'), 'utf-8');
    assert(
      httpCode.includes('X-API-Key'),
      'CORS Allow-Headers 应包含 X-API-Key'
    );
    assert(
      httpCode.includes('MCP-Protocol-Version'),
      'CORS Allow-Headers 应包含 MCP-Protocol-Version'
    );
  }),
];

// ── 主流程 ────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         PingCode MCP HTTP 安全与部署测试                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  // 1. 启动 Mock PingCode API
  await new Promise(resolve => mockServer.listen(MOCK_API_PORT, '127.0.0.1', resolve));

  // 2. 启动 MCP HTTP Server（工厂函数模式：每个 session 创建独立 Server）
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { startHttpServer } = await import('../dist/server/http.js');

  const serverFactory = () => new Server(
    { name: 'test-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  await startHttpServer(serverFactory);

  // 等待 HTTP Server 就绪（轮询 /health）
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) break;
    } catch { /* server not ready */ }
    await sleep(100);
  }

  // 3. 运行测试组
  const groups = [
    { name: 'SEC1: Origin 验证',       tests: sec1Tests },
    { name: 'SEC2: CORS 头',           tests: sec2Tests },
    { name: 'SEC3: API Key 鉴权',      tests: sec3Tests },
    { name: 'SEC4: 公开端点',          tests: sec4Tests },
    { name: 'SEC5: API 超时与重试',    tests: sec5Tests },
    { name: 'SEC6: Session 管理',      tests: sec6Tests },
    { name: 'SEC7: 请求解析与部署配置', tests: sec7Tests },
  ];

  for (const group of groups) {
    console.log(`📋 ${group.name}`);
    console.log('──────────────────────────────────────────────────────────────');
    for (const t of group.tests) {
      await runTest(t);
    }
    console.log('');
  }

  // 4. 汇总
  const total = results.passed + results.failed;
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('📊 测试结果汇总');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  总计: ${total} 个测试`);
  console.log(`  通过: ${results.passed} ✅`);
  console.log(`  失败: ${results.failed} ❌`);
  console.log(`  通过率: ${((results.passed / total) * 100).toFixed(1)}%`);
  console.log('');

  if (results.failed > 0) {
    console.log('❌ 失败的测试:');
    for (const t of results.tests.filter(t => t.status === 'FAIL')) {
      console.log(`  - ${t.name}: ${t.error}`);
    }
    console.log('');
  }

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('测试运行失败:', err);
  process.exit(1);
});
