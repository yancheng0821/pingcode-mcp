#!/usr/bin/env node
/**
 * PingCode MCP 回归烟测（Smoke Tests）
 *
 * 运行方式: node tests/regression.mjs
 *
 * 精简到 ~14 条烟测，覆盖关键在线路径。
 * 详细的行为测试已迁移到 vitest (test:unit + test:e2e)。
 *
 * 覆盖:
 * - AC1: 团队查询基础
 * - AC2: 时间分片
 * - AC3: 鉴权
 * - AC4: 指标
 * - AC5: 无数据
 * - AC6: 交互场景
 * - AC7: PRD 参数
 * - AC8: MCP isError 语义
 * - AC10: 聚合维度
 * - AC12: 缓存
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// 构建产物前置检查
const criticalModules = [
  'dist/server/mcp.js',
  'dist/tools/teamWorkSummary.js',
  'dist/tools/userWorkSummary.js',
  'dist/tools/listWorkloads.js',
];
const missing = criticalModules.filter(m => !fs.existsSync(join(projectRoot, m)));
if (missing.length > 0) {
  console.error('❌ 缺少构建产物，请先执行 npm run build\n');
  console.error('   缺失文件:');
  for (const m of missing) console.error(`     - ${m}`);
  process.exit(1);
}

// 测试结果收集
const results = { passed: 0, failed: 0, tests: [] };

function test(name, fn) { return { name, fn }; }

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

/** Parse JSON from MCP tool result content, skipping framing text blocks */
function parseResultContent(content) {
  for (const block of content) {
    try { return JSON.parse(block.text); } catch { /* skip */ }
  }
  throw new Error('No JSON content block found in result');
}

async function runTest(testCase) {
  const startTime = Date.now();
  try {
    await testCase.fn();
    const duration = Date.now() - startTime;
    results.passed++;
    results.tests.push({ name: testCase.name, status: 'PASS', duration });
    console.log(`  ✅ ${testCase.name} (${duration}ms)`);
    return true;
  } catch (error) {
    const duration = Date.now() - startTime;
    results.failed++;
    results.tests.push({ name: testCase.name, status: 'FAIL', duration, error: error.message });
    console.log(`  ❌ ${testCase.name} (${duration}ms)`);
    console.log(`     Error: ${error.message}`);
    return false;
  }
}

// ============ 动态测试夹具 ============

let _fixtureCache = null;

async function getFixtures() {
  if (_fixtureCache) return _fixtureCache;

  const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
  const result = await teamWorkSummary({
    time_range: { start: '2026-01-01', end: '2026-01-31' },
    group_by: 'user',
    top_n: 3
  });

  if (result.error) {
    throw new Error(`无法初始化测试夹具: ${result.error}`);
  }

  const memberWithHours = result.summary.members.find(m => m.total_hours > 0);
  if (!memberWithHours) {
    throw new Error('测试夹具: 找不到有工时记录的用户');
  }

  _fixtureCache = {
    userId: memberWithHours.user.id,
    userName: memberWithHours.user.name,
    userDisplayName: memberWithHours.user.display_name,
  };
  return _fixtureCache;
}

// ============ MCP Client/Server Helper ============

async function createMcpClientServer() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createMcpServer } = await import('../dist/server/mcp.js');

  const server = createMcpServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server, clientTransport, serverTransport };
}

// ============ AC1: 团队查询基础 ============
const ac1Tests = [
  test('AC1.1 - 返回全员列表', async () => {
    const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
    const result = await teamWorkSummary({
      time_range: { start: '2026-01-01', end: '2026-01-31' },
      group_by: 'user',
      top_n: 5
    });
    assert(!result.error, `返回错误: ${result.error}`);
    assert(result.summary.user_count >= 1, '应返回至少1个用户');
    assert(result.summary.members.length >= 1, '成员列表不能为空');
  }),

  test('AC1.2 - 每人包含 total_hours', async () => {
    const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
    const result = await teamWorkSummary({
      time_range: { start: '2026-01-01', end: '2026-01-31' },
      group_by: 'user',
      top_n: 5
    });
    assert(!result.error, `返回错误: ${result.error}`);
    for (const member of result.summary.members) {
      assert(typeof member.total_hours === 'number', `${member.user.display_name} 缺少 total_hours`);
      assert(member.total_hours >= 0, `${member.user.display_name} total_hours 应 >= 0`);
    }
  }),
];

// ============ AC2: 时间分片 ============
const ac2Tests = [
  test('AC2.1 - 超3个月自动分片', async () => {
    const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
    const result = await teamWorkSummary({
      time_range: { start: '2025-10-01', end: '2026-01-31' },
      group_by: 'user',
      top_n: 5
    });
    assert(!result.error, `返回错误: ${result.error}`);
    assert(result.data_quality.time_sliced === true, 'time_sliced 应为 true');
  }),
];

// ============ AC3: 鉴权 ============
const ac3Tests = [
  test('AC3.1 - API 调用成功 (Bearer token 有效)', async () => {
    const token = process.env.PINGCODE_TOKEN;
    assert(token, 'PINGCODE_TOKEN 环境变量未设置');

    const response = await fetch(
      'https://open.pingcode.com/v1/directory/users?page_size=1',
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    assert(response.ok, `API 调用失败: ${response.status}`);
    const data = await response.json();
    assert(data.total >= 0, '应返回用户总数');
  }),

  test('AC3.2 - 无效 token 返回 401', async () => {
    const response = await fetch(
      'https://open.pingcode.com/v1/directory/users?page_size=1',
      {
        headers: {
          'Authorization': 'Bearer invalid_token_12345',
          'Content-Type': 'application/json'
        }
      }
    );
    assert(response.status === 401, `无效 token 应返回 401，实际: ${response.status}`);
  }),
];

// ============ AC4: 指标 ============
const ac4Tests = [
  test('AC4.1 - metrics.getSnapshot() 返回正确结构', async () => {
    const { metrics } = await import('../dist/utils/metrics.js');
    const snapshot = metrics.getSnapshot();
    assert(typeof snapshot.uptime_seconds === 'number', '缺少 uptime_seconds');
    assert(typeof snapshot.requests === 'object', '缺少 requests');
    assert(typeof snapshot.requests.total === 'number', '缺少 requests.total');
    assert(typeof snapshot.cache === 'object', '缺少 cache');
    assert(typeof snapshot.cache.hit_rate === 'number', '缺少 cache.hit_rate');
  }),
];

// ============ AC5: 无数据 ============
const ac5Tests = [
  test('AC5.1 - 团队查询无数据返回 NO_DATA', async () => {
    const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
    const result = await teamWorkSummary({
      time_range: { start: '2030-01-01', end: '2030-01-31' },
      group_by: 'user',
      top_n: 5
    });
    assert(result.error, '无数据时应返回错误');
    assert(result.code === 'NO_DATA', `错误码应为 NO_DATA，实际: ${result.code}`);
  }),
];

// ============ AC6: 交互场景 ============
const ac6Tests = [
  test('AC6.1 - 团队月度工时汇总 + Top 5 工作项', async () => {
    const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
    const result = await teamWorkSummary({
      time_range: { start: '2026-01-01', end: '2026-01-31' },
      group_by: 'user',
      top_n: 5
    });
    assert(!result.error, `返回错误: ${result.error}`);
    assert(result.summary.members.length > 0, '应返回成员列表');
    for (const member of result.summary.members) {
      assert(member.user.display_name, '成员应有 display_name');
      assert(typeof member.total_hours === 'number', '成员应有 total_hours');
      assert(Array.isArray(member.top_work_items), '成员应有 top_work_items');
      assert(member.top_work_items.length <= 5, 'top_work_items 不应超过 5 个');
    }
  }),

  test('AC6.2 - 用户按天汇总', async () => {
    const { userWorkSummary } = await import('../dist/tools/userWorkSummary.js');
    const result = await userWorkSummary({
      user: { name: '颜成' },
      time_range: { start: '2026-01-01', end: '2026-01-31' },
      group_by: 'day',
      top_n: 3
    });
    assert(!result.error, `返回错误: ${result.error}`);
    assert(result.summary.user.display_name === '颜成', '应返回正确的用户');
    assert(typeof result.summary.total_hours === 'number', '应有 total_hours');
    assert(Array.isArray(result.summary.by_day), '应有 by_day 数组');
  }),
];

// ============ AC7: PRD 参数 ============
const ac7Tests = [
  test('AC7.1 - principal_type=user 查询用户工时', async () => {
    const { listWorkloads } = await import('../dist/tools/listWorkloads.js');
    const { listUsers } = await import('../dist/api/endpoints/users.js');
    const users = await listUsers();
    assert(users.length > 0, '应有至少一个用户');
    const testUserId = users[0].id;

    const result = await listWorkloads({
      principal_type: 'user',
      principal_id: testUserId,
      time_range: { start: '2026-01-01', end: '2026-01-31' },
    });

    if (result.error && result.code !== 'NO_DATA') {
      assert(false, `返回错误: ${result.error}`);
    }

    if (!result.error && result.workloads) {
      for (const workload of result.workloads) {
        assert(
          workload.user.id === testUserId,
          `工时应属于指定用户，实际用户: ${workload.user.id}`
        );
      }
    }
  }),
];

// ============ AC8: MCP isError 语义 ============
const ac8Tests = [
  test('AC8.1 - NO_DATA 经 MCP 返回 isError=true', async () => {
    const { client, clientTransport, serverTransport } = await createMcpClientServer();
    try {
      const result = await client.callTool({
        name: 'team_work_summary',
        arguments: {
          time_range: { start: '2030-01-01', end: '2030-01-31' },
          group_by: 'user',
          top_n: 5,
          include_zero_users: false,
        },
      });
      assert(result.isError === true, `NO_DATA 应标记 isError=true，实际: ${result.isError}`);
      const body = parseResultContent(result.content);
      assert(body.code === 'NO_DATA', `错误码应为 NO_DATA，实际: ${body.code}`);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  }),

  test('AC8.2 - 正常数据经 MCP 返回 isError 不为 true', async () => {
    const { client, clientTransport, serverTransport } = await createMcpClientServer();
    try {
      const result = await client.callTool({
        name: 'team_work_summary',
        arguments: {
          time_range: { start: '2026-01-01', end: '2026-01-31' },
          group_by: 'user',
          top_n: 5,
        },
      });
      assert(result.isError !== true, '正常数据不应标记 isError=true');
      const body = parseResultContent(result.content);
      assert(!body.code, `正常数据不应有 code 字段，实际: ${body.code}`);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  }),
];

// ============ AC10: 聚合维度 ============
const ac10Tests = [
  test('AC10.1 - group_by=week 返回 ISO 8601 周格式', async () => {
    const fixtures = await getFixtures();
    const { userWorkSummary } = await import('../dist/tools/userWorkSummary.js');
    const result = await userWorkSummary({
      user: { id: fixtures.userId },
      time_range: { start: '2026-01-01', end: '2026-01-31' },
      group_by: 'week',
      top_n: 5
    });
    assert(!result.error, `返回错误: ${result.error}`);
    assert(Array.isArray(result.summary.by_week), '应有 by_week 数组');
    assert(result.summary.by_week.length > 0, 'by_week 应非空');

    const weekRegex = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
    for (const entry of result.summary.by_week) {
      assert(weekRegex.test(entry.week), `周格式应为 ISO 8601，实际: ${entry.week}`);
      assert(typeof entry.hours === 'number', 'by_week 条目应有 hours');
    }
  }),
];

// ============ AC12: 缓存 ============
const ac12Tests = [
  test('AC12.1 - 用户列表第二次查询命中缓存', async () => {
    const { metrics } = await import('../dist/utils/metrics.js');
    const { listUsers } = await import('../dist/api/endpoints/users.js');
    await listUsers();
    const snapshot1 = metrics.getSnapshot();
    await listUsers();
    const snapshot2 = metrics.getSnapshot();
    assert(
      snapshot2.cache.hits > snapshot1.cache.hits,
      `第二次调用 cache.hits 应增加（before: ${snapshot1.cache.hits}, after: ${snapshot2.cache.hits}）`
    );
  }),
];

// ============ 运行测试 ============
async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           PingCode MCP 回归烟测                            ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const testGroups = [
    { name: 'AC1: 团队查询基础', tests: ac1Tests },
    { name: 'AC2: 时间分片', tests: ac2Tests },
    { name: 'AC3: 鉴权', tests: ac3Tests },
    { name: 'AC4: 指标', tests: ac4Tests },
    { name: 'AC5: 无数据', tests: ac5Tests },
    { name: 'AC6: 交互场景', tests: ac6Tests },
    { name: 'AC7: PRD 参数', tests: ac7Tests },
    { name: 'AC8: MCP isError 语义', tests: ac8Tests },
    { name: 'AC10: 聚合维度', tests: ac10Tests },
    { name: 'AC12: 缓存', tests: ac12Tests },
  ];

  for (const group of testGroups) {
    console.log(`\n📋 ${group.name}`);
    console.log('─'.repeat(50));
    for (const testCase of group.tests) {
      await runTest(testCase);
    }
  }

  // 输出总结
  console.log('\n' + '═'.repeat(60));
  console.log('📊 测试结果汇总');
  console.log('═'.repeat(60));
  console.log(`  总计: ${results.passed + results.failed} 个测试`);
  console.log(`  通过: ${results.passed} ✅`);
  console.log(`  失败: ${results.failed} ❌`);
  console.log(`  通过率: ${((results.passed / (results.passed + results.failed)) * 100).toFixed(1)}%`);

  if (results.failed > 0) {
    console.log('\n❌ 失败的测试:');
    for (const test of results.tests.filter(t => t.status === 'FAIL')) {
      console.log(`  - ${test.name}: ${test.error}`);
    }
    process.exit(1);
  } else {
    console.log('\n✅ 所有测试通过!');
    process.exit(0);
  }
}

runAllTests().catch(error => {
  console.error('测试运行失败:', error);
  process.exit(1);
});
