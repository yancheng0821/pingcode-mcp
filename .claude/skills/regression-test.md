---
name: regression-test
description: 运行 PingCode MCP 全量测试，验证所有 AC 和安全/可靠性测试是否通过
---

# PingCode MCP 回归测试

当用户要求运行回归测试、验证功能、检查系统是否正常时，执行此 skill。

## 测试套件总览

| 套件 | 命令 | 数量 | 说明 |
|------|------|------|------|
| 回归测试 | `node tests/regression.mjs` | 14 | AC1–AC12，需要真实 PingCode API |
| 单元测试 | `npm run test:unit` | 130 | vitest，全 mock，无网络依赖（15 个文件） |
| E2E 测试 | `npm run test:e2e` | 48 | vitest + Mock 服务器（7 个文件） |
| HTTP 安全 | `npm run test:http` | 23 | 鉴权/CORS/Session/超时/Body 限制 |

## 回归测试覆盖 (14 个测试，AC1–AC12 核心路径)

- **AC1**: 团队时间段查询（2个）- AC1.1 全员列表、AC1.2 每人含 total_hours
- **AC2**: 跨度超3个月自动分片（1个）- AC2.1 time_sliced 标记
- **AC3**: 权限与鉴权（2个）- AC3.1 Bearer token 成功、AC3.2 无效 token 返回 401
- **AC4**: 可观测性指标（1个）- AC4.1 metrics 结构
- **AC5**: 无数据返回 NO_DATA（1个）- AC5.1 团队查询
- **AC6**: 交互示例场景（2个）- AC6.1 团队月度汇总 Top 5、AC6.2 用户按天汇总
- **AC7**: list_workloads PRD 参数（1个）- AC7.1 principal_type=user
- **AC8**: MCP 业务错误 isError 语义（2个）- AC8.1 NO_DATA → isError=true、AC8.2 正常数据 → isError 不为 true
- **AC10**: 聚合维度正确性（1个）- AC10.1 ISO 8601 周格式
- **AC12**: 查询性能与缓存（1个）- AC12.1 用户列表缓存命中

## 单元测试覆盖 (130 个测试，15 个文件)

- **pagination** - 分页终止（maxPages/maxRecords/fetchError/timeout）、truncationReasons、去重
- **signalPropagation** - AbortSignal 透传、wall-clock 超时
- **metrics** - 指标快照、数据质量记录
- **cors** - Origin 校验、CORS 头
- **rateLimiter** - 令牌桶限流
- **timeUtils** - 日期解析、中文别名、时间分片
- **sanitize** - 控制字符过滤、截断
- **structuredContent** - structuredContent 字段
- **schemaConsistency** - Zod schema 与 MCP inputSchema 一致性
- **scopeEnforcer** - user mode 作用域限制
- **workItemBatchCache** - 工作项批量缓存
- **zeroHourUsers** - 0 工时用户包含/排除
- **multiApiKey** - 多 Key 轮换鉴权
- **retryJitter** - 指数退避 + jitter
- **tieredFetch** - 分层批量拉取策略

## E2E 测试覆盖 (48 个测试，7 个文件)

- **mcpStdio** - stdio 传输端到端
- **mockE2E** - InMemoryTransport 全链路（list_users、user_work_summary、team_work_summary、get_work_item、list_workloads、builtin tools）
- **outputContract** - MCP 输出契约与 schema 合规
- **promptInjection** - 控制字符与 framing block
- **upstreamApiFailure** - 上游 API 失败与部分结果
- **userMode** - TOKEN_MODE=user 作用域限制
- **nullProjectFallback** - 缺失项目信息降级

## HTTP 安全测试覆盖 (23 个测试)

- **SEC1** Origin 验证（3）、**SEC2** CORS 头（3）、**SEC3** API Key 鉴权（4）
- **SEC4** 公开端点与鉴权端点（4）、**SEC5** API 超时与重试（2）、**SEC6** Session 管理（3）
- **SEC7** 请求解析与部署配置（4：非法 JSON、超大 Body 413、绑定地址、CORS 头完整性）

## 执行步骤

### 快速验证（无网络依赖）

```bash
npm run build && npm run test:unit && npm run test:e2e
```

### 完整验证（包含真实 API 回归 + HTTP 安全）

```bash
npm run build
npm run test:unit      # 130 unit tests
npm run test:e2e       # 48 E2E tests
npm run test:http      # 23 HTTP security tests
node tests/regression.mjs  # 14 regression tests (需要 PINGCODE_TOKEN)
```

### 检查结果

- 全部通过 → 系统正常
- 有测试失败 → 检查失败原因并修复

## 失败时的处理

| 失败范围 | 排查方向 |
|----------|----------|
| AC1/AC2 | PingCode API 返回格式是否变化 |
| AC3 | token 是否过期，需要刷新 |
| AC4 | metrics 模块是否被修改 |
| AC5 | NO_DATA 错误处理逻辑 |
| AC7 | list_workloads 参数映射 |
| AC8 | isBusinessError 检测逻辑 |
| AC9–AC11 | schema/参数校验逻辑 |
| AC12 | 缓存/查询策略 |
| pagination tests | 分页循环、truncationReasons、maxFetchDurationMs |
| signalPropagation | AbortSignal 合并、toolCallTimeoutMs |
| HTTP tests | 鉴权中间件、CORS、Session 管理 |

## 刷新 Token

如果 token 过期，使用以下命令刷新：

```bash
curl -s "https://open.pingcode.com/v1/auth/token?grant_type=client_credentials&client_id=YOUR_CLIENT_ID&client_secret=YOUR_SECRET"
```

然后更新 `.env` 和 Claude Desktop 配置中的 `PINGCODE_TOKEN`。
