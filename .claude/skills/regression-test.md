---
name: regression-test
description: 运行 PingCode MCP 回归测试，验证所有 AC 是否通过
---

# PingCode MCP 回归测试

当用户要求运行回归测试、验证功能、检查系统是否正常时，执行此 skill。

## 测试覆盖 (24 个测试)

- **AC1**: 团队时间段查询（5个）- 全员列表、total_hours、Top items、workload_id、identifier/title
- **AC2**: 跨度超3个月自动分片（3个）- time_sliced 标记、数据合并、小于3月不分片
- **AC3**: 权限与鉴权（4个）- token 必填、Bearer 格式、API 成功、401 错误
- **AC4**: 可观测性指标（4个）- metrics 结构、请求统计、缓存命中率、分片统计
- **AC5**: 无数据返回 NO_DATA（2个）- 团队查询、用户查询
- **AC6**: 交互示例场景（6个）- 真实用户场景模拟

## 执行步骤

1. 确保项目已编译：
```bash
npm run build
```

2. 运行回归测试：
```bash
node tests/regression.mjs
```

3. 检查测试结果：
   - 所有测试通过 → 系统正常
   - 有测试失败 → 检查失败原因并修复

## 预期输出

```
╔════════════════════════════════════════════════════════════╗
║           PingCode MCP 回归测试                            ║
╚════════════════════════════════════════════════════════════╝

📋 AC1: 团队时间段查询
  ✅ AC1.1 - 返回全员列表
  ✅ AC1.2 - 每人包含 total_hours
  ...

📋 AC6: 交互示例场景
  ✅ AC6.1 - 团队月度工时汇总 + Top 5 工作项
  ✅ AC6.2 - 用户按天汇总 + Top N 工作项
  ✅ AC6.3 - 按项目过滤 + 按人排序
  ✅ AC6.4 - 用户名模糊匹配
  ✅ AC6.5 - 多项目工时汇总
  ✅ AC6.6 - 人天矩阵

📊 测试结果汇总
════════════════════════════════════════════════════════════
  总计: 24 个测试
  通过: 24 ✅
  失败: 0 ❌
  通过率: 100.0%

✅ 所有测试通过!
```

## 失败时的处理

如果测试失败，按以下步骤排查：

1. **AC1/AC2 失败** - 检查 PingCode API 返回格式是否变化
2. **AC3 失败** - 检查 token 是否过期，需要刷新
3. **AC4 失败** - 检查 metrics 模块是否被修改
4. **AC5 失败** - 检查 NO_DATA 错误处理逻辑

## 刷新 Token

如果 token 过期，使用以下命令刷新：

```bash
curl -s "https://open.pingcode.com/v1/auth/token?grant_type=client_credentials&client_id=YOUR_CLIENT_ID&client_secret=YOUR_SECRET"
```

然后更新 `.env` 和 Claude Desktop 配置中的 `PINGCODE_TOKEN`。
