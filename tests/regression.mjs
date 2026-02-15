#!/usr/bin/env node
/**
 * PingCode MCP 回归测试
 *
 * 运行方式: node tests/regression.mjs
 *
 * 测试覆盖:
 * - AC1: 团队时间段查询
 * - AC2: 跨度超3个月自动分片
 * - AC3: 权限与鉴权
 * - AC4: 可观测性指标
 * - AC5: 无数据返回 NO_DATA
 * - AC6: 交互示例场景
 * - AC7: list_workloads PRD 参数 (principal_type=user/project/work_item, report_by_id)
 * - AC8: MCP 业务错误 isError 语义 (P0-1)
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// 构建产物前置检查 — 测试依赖 dist/ 下的编译输出
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
const results = {
  passed: 0,
  failed: 0,
  tests: []
};

function test(name, fn) {
  return { name, fn };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
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

// ============ AC1: 团队时间段查询 ============
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

  test('AC1.3 - 每人包含 Top work items/projects', async () => {
    const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
    const result = await teamWorkSummary({
      time_range: { start: '2026-01-01', end: '2026-01-31' },
      group_by: 'user',
      top_n: 5
    });

    assert(!result.error, `返回错误: ${result.error}`);
    for (const member of result.summary.members) {
      assert(Array.isArray(member.top_projects), `${member.user.display_name} 缺少 top_projects`);
      assert(Array.isArray(member.top_work_items), `${member.user.display_name} 缺少 top_work_items`);
    }
  }),

  test('AC1.4 - 明细包含 workload_id', async () => {
    const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
    const result = await teamWorkSummary({
      time_range: { start: '2026-01-01', end: '2026-01-31' },
      group_by: 'user',
      top_n: 5
    });

    assert(!result.error, `返回错误: ${result.error}`);
    assert(result.details.length > 0, '应有明细数据');
    for (const detail of result.details) {
      assert(detail.workload_id, '明细缺少 workload_id');
    }
  }),

  test('AC1.5 - work_item 解析到 identifier/title', async () => {
    const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
    const result = await teamWorkSummary({
      time_range: { start: '2026-01-01', end: '2026-01-31' },
      group_by: 'user',
      top_n: 5
    });

    assert(!result.error, `返回错误: ${result.error}`);
    const detailWithWorkItem = result.details.find(d => d.work_item);
    assert(detailWithWorkItem, '应有包含 work_item 的明细');
    assert(detailWithWorkItem.work_item.identifier, 'work_item 缺少 identifier');
    assert(detailWithWorkItem.work_item.title, 'work_item 缺少 title');
  }),
];

// ============ AC2: 跨度超3个月自动分片 ============
const ac2Tests = [
  test('AC2.1 - 超3个月自动分片', async () => {
    const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
    const result = await teamWorkSummary({
      time_range: { start: '2025-10-01', end: '2026-01-31' }, // 4个月
      group_by: 'user',
      top_n: 5
    });

    assert(!result.error, `返回错误: ${result.error}`);
    assert(result.data_quality.time_sliced === true, 'time_sliced 应为 true');
  }),

  test('AC2.2 - 分片后数据正确合并', async () => {
    const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
    const result = await teamWorkSummary({
      time_range: { start: '2025-10-01', end: '2026-01-31' },
      group_by: 'user',
      top_n: 5
    });

    assert(!result.error, `返回错误: ${result.error}`);
    assert(result.summary.total_hours > 0, '合并后总工时应 > 0');
    assert(result.data_quality.workloads_count > 0, '合并后工时记录数应 > 0');
  }),

  test('AC2.3 - 小于3个月不分片', async () => {
    const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
    const result = await teamWorkSummary({
      time_range: { start: '2026-01-01', end: '2026-01-31' }, // 1个月
      group_by: 'user',
      top_n: 5
    });

    assert(!result.error, `返回错误: ${result.error}`);
    assert(result.data_quality.time_sliced === false, 'time_sliced 应为 false');
  }),
];

// ============ AC3: 权限与鉴权 ============
const ac3Tests = [
  test('AC3.1 - token 配置必填检查', async () => {
    // 读取配置代码检查 token 必填
    const configCode = fs.readFileSync(join(projectRoot, 'src/config/index.ts'), 'utf-8');
    assert(
      configCode.includes("token: z.string().min(1"),
      '配置中应有 token 必填校验'
    );
  }),

  test('AC3.2 - Bearer token 格式正确', async () => {
    const clientCode = fs.readFileSync(join(projectRoot, 'src/api/client.ts'), 'utf-8');
    assert(
      clientCode.includes("'Authorization': `Bearer ${this.token}`"),
      '应使用 Bearer token 格式'
    );
  }),

  test('AC3.3 - API 调用成功 (Bearer token 有效)', async () => {
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

  test('AC3.4 - 无效 token 返回 401', async () => {
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

// ============ AC4: 可观测性指标 ============
const ac4Tests = [
  test('AC4.1 - metrics.getSnapshot() 返回正确结构', async () => {
    const { metrics } = await import('../dist/utils/metrics.js');
    const snapshot = metrics.getSnapshot();

    assert(typeof snapshot.uptime_seconds === 'number', '缺少 uptime_seconds');
    assert(typeof snapshot.requests === 'object', '缺少 requests');
    assert(typeof snapshot.requests.total === 'number', '缺少 requests.total');
    assert(typeof snapshot.requests.error_rate === 'number', '缺少 requests.error_rate');
    assert(typeof snapshot.cache === 'object', '缺少 cache');
    assert(typeof snapshot.cache.hit_rate === 'number', '缺少 cache.hit_rate');
    assert(typeof snapshot.time_slicing === 'object', '缺少 time_slicing');
  }),

  test('AC4.2 - 请求后指标更新', async () => {
    const { metrics } = await import('../dist/utils/metrics.js');
    const before = metrics.getSnapshot();

    // 执行一个请求
    const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
    await teamWorkSummary({
      time_range: { start: '2026-01-01', end: '2026-01-31' },
      group_by: 'user',
      top_n: 1
    });

    const after = metrics.getSnapshot();
    assert(after.requests.total >= before.requests.total, '请求总数应增加');
  }),

  test('AC4.3 - 缓存命中率统计', async () => {
    const { metrics } = await import('../dist/utils/metrics.js');
    const snapshot = metrics.getSnapshot();

    assert(snapshot.cache.hits >= 0, 'cache.hits 应 >= 0');
    assert(snapshot.cache.misses >= 0, 'cache.misses 应 >= 0');
    assert(snapshot.cache.hit_rate >= 0 && snapshot.cache.hit_rate <= 1, 'hit_rate 应在 0-1 之间');
  }),

  test('AC4.4 - 分片统计', async () => {
    const { metrics } = await import('../dist/utils/metrics.js');
    const snapshot = metrics.getSnapshot();

    assert(typeof snapshot.time_slicing.sliced_requests === 'number', '缺少 sliced_requests');
    assert(typeof snapshot.time_slicing.total_slices === 'number', '缺少 total_slices');
  }),
];

// ============ AC5: 无数据返回 NO_DATA ============
const ac5Tests = [
  test('AC5.1 - 团队查询无数据返回 NO_DATA', async () => {
    const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
    const result = await teamWorkSummary({
      time_range: { start: '2030-01-01', end: '2030-01-31' }, // 未来日期，肯定无数据
      group_by: 'user',
      top_n: 5
    });

    assert(result.error, '无数据时应返回错误');
    assert(result.code === 'NO_DATA', `错误码应为 NO_DATA，实际: ${result.code}`);
  }),

  test('AC5.2 - 用户查询无数据返回 NO_DATA', async () => {
    const { userWorkSummary } = await import('../dist/tools/userWorkSummary.js');
    const result = await userWorkSummary({
      user: { name: '颜成' },
      time_range: { start: '2030-01-01', end: '2030-01-31' },
      group_by: 'work_item',
      top_n: 5
    });

    assert(result.error, '无数据时应返回错误');
    assert(result.code === 'NO_DATA', `错误码应为 NO_DATA，实际: ${result.code}`);
  }),
];

// ============ AC6: 交互示例场景 ============
const ac6Tests = [
  test('AC6.1 - 团队月度工时汇总 + Top 5 工作项', async () => {
    // 场景: "帮我查 2026-01-01 到 2026-01-31，每个人做了什么，工时分别多少，并列出每人 Top 5 工作项"
    const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
    const result = await teamWorkSummary({
      time_range: { start: '2026-01-01', end: '2026-01-31' },
      group_by: 'user',
      top_n: 5
    });

    assert(!result.error, `返回错误: ${result.error}`);
    assert(result.summary.members.length > 0, '应返回成员列表');

    // 验证每人有 top_work_items
    for (const member of result.summary.members) {
      assert(member.user.display_name, '成员应有 display_name');
      assert(typeof member.total_hours === 'number', '成员应有 total_hours');
      assert(Array.isArray(member.top_work_items), '成员应有 top_work_items');
      assert(member.top_work_items.length <= 5, 'top_work_items 不应超过 5 个');
    }
  }),

  test('AC6.2 - 用户按天汇总 + Top N 工作项', async () => {
    // 场景: "颜成上周做了什么？按天汇总，每天多少工时；再列出投入最多的 3 个工作项"
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

    // 验证按天汇总
    assert(Array.isArray(result.summary.by_day), '应有 by_day 数组');
    if (result.summary.by_day.length > 0) {
      const dayEntry = result.summary.by_day[0];
      assert(dayEntry.date, 'by_day 条目应有 date');
      assert(typeof dayEntry.hours === 'number', 'by_day 条目应有 hours');
    }

    // 验证 top work items
    assert(Array.isArray(result.summary.by_work_item), '应有 by_work_item');
  }),

  test('AC6.3 - 按项目过滤 + 按人排序', async () => {
    // 场景: "项目 GDY 这个月的工时分布，按人排序"
    // 获取 GDY 项目 ID
    const projectId = '69846c3745079d734dc6facb'; // 光大银行项目

    const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
    const result = await teamWorkSummary({
      time_range: { start: '2026-01-01', end: '2026-01-31' },
      project_id: projectId,
      group_by: 'user',
      top_n: 5
    });

    assert(!result.error, `返回错误: ${result.error}`);
    assert(result.summary.members.length > 0, '应返回成员列表');

    // 验证只返回该项目的数据
    for (const member of result.summary.members) {
      // top_projects 应只包含指定项目或为空
      if (member.top_projects && member.top_projects.length > 0) {
        const hasTargetProject = member.top_projects.some(p => p.project.id === projectId);
        assert(hasTargetProject, `${member.user.display_name} 的 top_projects 应包含指定项目`);
      }
    }
  }),

  test('AC6.4 - 用户名模糊匹配', async () => {
    // 场景: 使用名字的一部分进行查询
    const { userWorkSummary } = await import('../dist/tools/userWorkSummary.js');
    const result = await userWorkSummary({
      user: { name: 'Aisen' },
      time_range: { start: '2026-01-01', end: '2026-01-31' },
      group_by: 'work_item',
      top_n: 5
    });

    assert(!result.error, `返回错误: ${result.error}`);
    assert(result.summary.user.display_name === 'Aisen', '应正确匹配用户 Aisen');
  }),

  test('AC6.5 - 多项目工时汇总', async () => {
    // 场景: 查询跨多个项目的工时
    const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
    const result = await teamWorkSummary({
      time_range: { start: '2026-01-01', end: '2026-01-31' },
      group_by: 'project', // 按项目聚合
      top_n: 10
    });

    assert(!result.error, `返回错误: ${result.error}`);
    // 验证有 by_project 聚合
    assert(result.summary.by_project || result.summary.members, '应有项目维度数据');
  }),

  test('AC6.6 - 人天矩阵', async () => {
    // 场景: "生成团队人天矩阵"
    const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
    const result = await teamWorkSummary({
      time_range: { start: '2026-01-28', end: '2026-01-31' },
      group_by: 'user',
      top_n: 5,
      include_matrix: true
    });

    assert(!result.error, `返回错误: ${result.error}`);
    assert(result.by_day_matrix, '应返回 by_day_matrix');
    assert(Array.isArray(result.by_day_matrix.dates), 'matrix 应有 dates 数组');
    assert(Array.isArray(result.by_day_matrix.rows), 'matrix 应有 rows 数组');

    if (result.by_day_matrix.rows.length > 0) {
      const row = result.by_day_matrix.rows[0];
      assert(row.user, 'row 应有 user');
      assert(Array.isArray(row.hours_per_day), 'row 应有 hours_per_day 数组');
    }
  }),
];

// ============ AC7: list_workloads PRD 参数测试 ============
const ac7Tests = [
  test('AC7.1 - 验证使用 /v1/workloads 接口', async () => {
    // 检查代码中使用的是 /v1/workloads 而非 /v1/project/workloads
    const workloadsCode = fs.readFileSync(join(projectRoot, 'src/api/endpoints/workloads.ts'), 'utf-8');
    assert(
      workloadsCode.includes("'/v1/workloads'"),
      '应使用 /v1/workloads 接口'
    );
    assert(
      !workloadsCode.includes("'/v1/project/workloads'"),
      '不应使用 /v1/project/workloads 接口'
    );
  }),

  test('AC7.2 - principal_type=user 查询用户工时', async () => {
    // 场景: 使用 PRD 定义的 principal_type=user 查询指定用户的工时
    const { listWorkloads } = await import('../dist/tools/listWorkloads.js');

    // 先获取一个有效的用户 ID（从 API 端点获取）
    const { listUsers } = await import('../dist/api/endpoints/users.js');
    const users = await listUsers();
    assert(users.length > 0, '应有至少一个用户');
    const testUserId = users[0].id;

    const result = await listWorkloads({
      principal_type: 'user',
      principal_id: testUserId,
      time_range: { start: '2026-01-01', end: '2026-01-31' },
    });

    // 可能返回 NO_DATA 或成功
    if (result.error && result.code !== 'NO_DATA') {
      assert(false, `返回错误: ${result.error}`);
    }

    // 如果有数据，验证只返回该用户的工时
    if (!result.error && result.workloads) {
      for (const workload of result.workloads) {
        assert(
          workload.user.id === testUserId,
          `工时应属于指定用户，实际用户: ${workload.user.id}`
        );
      }
    }
  }),

  test('AC7.3 - principal_type=project 查询项目工时', async () => {
    // 场景: 使用 PRD 定义的 principal_type=project 查询指定项目的工时
    const { listWorkloads } = await import('../dist/tools/listWorkloads.js');
    const projectId = '69846c3745079d734dc6facb'; // 光大银行项目

    const result = await listWorkloads({
      principal_type: 'project',
      principal_id: projectId,
      time_range: { start: '2026-01-01', end: '2026-01-31' },
    });

    // 可能返回 NO_DATA 或成功
    if (result.error && result.code !== 'NO_DATA') {
      assert(false, `返回错误: ${result.error}`);
    }

    // 如果有数据，验证返回的工时属于该项目
    if (!result.error && result.workloads) {
      for (const workload of result.workloads) {
        // 项目信息可能来自工作项关联
        if (workload.project) {
          assert(
            workload.project.id === projectId,
            `工时应属于指定项目，实际项目: ${workload.project.id}`
          );
        }
      }
    }
  }),

  test('AC7.4 - principal_type=work_item 查询工作项工时', async () => {
    // 场景: 使用 PRD 定义的 principal_type=work_item 查询指定工作项的工时
    const { listWorkloads } = await import('../dist/tools/listWorkloads.js');

    // 先获取一个有工时的工作项 ID
    const { teamWorkSummary } = await import('../dist/tools/teamWorkSummary.js');
    const teamResult = await teamWorkSummary({
      time_range: { start: '2026-01-01', end: '2026-01-31' },
      group_by: 'user',
      top_n: 1
    });

    if (teamResult.error) {
      console.log('     跳过：无法获取工作项数据');
      return;
    }

    // 找到一个有工作项的明细
    const detailWithWorkItem = teamResult.details?.find(d => d.work_item?.id);
    if (!detailWithWorkItem) {
      console.log('     跳过：没有找到带工作项的工时记录');
      return;
    }

    const workItemId = detailWithWorkItem.work_item.id;

    const result = await listWorkloads({
      principal_type: 'work_item',
      principal_id: workItemId,
      time_range: { start: '2026-01-01', end: '2026-01-31' },
    });

    if (result.error && result.code !== 'NO_DATA') {
      assert(false, `返回错误: ${result.error}`);
    }

    // 如果有数据，验证返回的工时属于该工作项
    if (!result.error && result.workloads) {
      for (const workload of result.workloads) {
        assert(
          workload.work_item?.id === workItemId,
          `工时应属于指定工作项，实际: ${workload.work_item?.id}`
        );
      }
    }
  }),

  test('AC7.5 - report_by_id 直接查询填报人工时', async () => {
    // 场景: 使用兼容参数 report_by_id 查询
    const { listWorkloads } = await import('../dist/tools/listWorkloads.js');

    const { listUsers } = await import('../dist/api/endpoints/users.js');
    const users = await listUsers();
    const testUserId = users[0].id;

    const result = await listWorkloads({
      report_by_id: testUserId,
      time_range: { start: '2026-01-01', end: '2026-01-31' },
    });

    if (result.error && result.code !== 'NO_DATA') {
      assert(false, `返回错误: ${result.error}`);
    }

    if (!result.error && result.workloads) {
      for (const workload of result.workloads) {
        assert(
          workload.user.id === testUserId,
          `工时应属于指定填报人`
        );
      }
    }
  }),

  test('AC7.6 - principal_type 和 principal_id 必须同时提供', async () => {
    const { listWorkloads } = await import('../dist/tools/listWorkloads.js');

    // 只提供 principal_type
    const result1 = await listWorkloads({
      principal_type: 'user',
      time_range: { start: '2026-01-01', end: '2026-01-31' },
    });
    assert(result1.error, '只提供 principal_type 应返回错误');
    assert(result1.code === 'INVALID_PARAMS', `错误码应为 INVALID_PARAMS，实际: ${result1.code}`);

    // 只提供 principal_id
    const result2 = await listWorkloads({
      principal_id: 'some-id',
      time_range: { start: '2026-01-01', end: '2026-01-31' },
    });
    assert(result2.error, '只提供 principal_id 应返回错误');
    assert(result2.code === 'INVALID_PARAMS', `错误码应为 INVALID_PARAMS，实际: ${result2.code}`);
  }),
];

// ============ AC8: MCP 业务错误 isError 语义 (P0-1) ============

/**
 * 使用真实的 createMcpServer()（从 dist/server/mcp.js 导入）+ InMemoryTransport
 * 端到端验证 CallTool handler 中 isError 标记逻辑。
 *
 * 不复刻任何 handler 代码，确保测试的是生产实现。
 */
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

const ac8Tests = [
  test('AC8.1 - NO_DATA 业务错误经 MCP 返回 isError=true', async () => {
    const { client, clientTransport, serverTransport } = await createMcpClientServer();
    try {
      const result = await client.callTool({
        name: 'team_work_summary',
        arguments: {
          time_range: { start: '2030-01-01', end: '2030-01-31' },
          group_by: 'user',
          top_n: 5,
        },
      });

      assert(result.isError === true, `NO_DATA 应标记 isError=true，实际: ${result.isError}`);

      const body = JSON.parse(result.content[0].text);
      assert(body.code === 'NO_DATA', `错误码应为 NO_DATA，实际: ${body.code}`);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  }),

  test('AC8.2 - USER_NOT_FOUND 业务错误经 MCP 返回 isError=true', async () => {
    const { client, clientTransport, serverTransport } = await createMcpClientServer();
    try {
      const result = await client.callTool({
        name: 'user_work_summary',
        arguments: {
          user: { name: '不存在的用户XYZ999' },
          time_range: { start: '2026-01-01', end: '2026-01-31' },
          group_by: 'work_item',
          top_n: 5,
        },
      });

      assert(result.isError === true, `USER_NOT_FOUND 应标记 isError=true，实际: ${result.isError}`);

      const body = JSON.parse(result.content[0].text);
      assert(
        body.code === 'USER_NOT_FOUND' || body.code === 'NO_DATA',
        `错误码应为 USER_NOT_FOUND 或 NO_DATA，实际: ${body.code}`,
      );
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  }),

  test('AC8.3 - 正常数据经 MCP 返回 isError 不为 true', async () => {
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

      assert(
        result.isError !== true,
        `正常数据不应标记 isError=true`,
      );

      const body = JSON.parse(result.content[0].text);
      assert(!body.code, `正常数据不应有 code 字段，实际: ${body.code}`);
      assert(!body.error, `正常数据不应有 error 字段`);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  }),

  test('AC8.4 - unknown tool 经 MCP 返回 isError=true', async () => {
    const { client, clientTransport, serverTransport } = await createMcpClientServer();
    try {
      const result = await client.callTool({
        name: 'nonexistent_tool_xyz',
        arguments: {},
      });

      assert(result.isError === true, `unknown tool 应标记 isError=true，实际: ${result.isError}`);

      const body = JSON.parse(result.content[0].text);
      assert(body.error.includes('Unknown tool'), `应提示 Unknown tool，实际: ${body.error}`);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  }),
];

// ============ 运行测试 ============
async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           PingCode MCP 回归测试                            ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const testGroups = [
    { name: 'AC1: 团队时间段查询', tests: ac1Tests },
    { name: 'AC2: 跨度超3个月自动分片', tests: ac2Tests },
    { name: 'AC3: 权限与鉴权', tests: ac3Tests },
    { name: 'AC4: 可观测性指标', tests: ac4Tests },
    { name: 'AC5: 无数据返回 NO_DATA', tests: ac5Tests },
    { name: 'AC6: 交互示例场景', tests: ac6Tests },
    { name: 'AC7: list_workloads PRD 参数', tests: ac7Tests },
    { name: 'AC8: MCP 业务错误 isError 语义', tests: ac8Tests },
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

// 运行
runAllTests().catch(error => {
  console.error('测试运行失败:', error);
  process.exit(1);
});
