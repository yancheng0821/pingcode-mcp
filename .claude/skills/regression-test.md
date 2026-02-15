---
name: regression-test
description: 运行 PingCode MCP 全量测试，验证所有 AC 和安全/可靠性测试是否通过
---

# PingCode MCP 回归测试

当用户要求运行回归测试、验证功能、检查系统是否正常时，执行此 skill。

## 测试套件总览

| 套件 | 命令 | 数量 | 说明 |
|------|------|------|------|
| 回归测试 | `node tests/regression.mjs` | 51 | AC1–AC12，需要真实 PingCode API |
| 单元 + E2E | `npm run test:all` | 136 | vitest，全 mock，无网络依赖 |
| HTTP 安全 | `npm run test:http` | 22 | 鉴权/CORS/Session/超时 |

## 回归测试覆盖 (51 个测试，AC1–AC12)

- **AC1**: 团队时间段查询（8个）- 全员列表、total_hours、Top items、workload_id、identifier/title、0 工时用户、按项目过滤 missing_work_item_count、data_quality 有效值
- **AC2**: 跨度超3个月自动分片（3个）- time_sliced 标记、数据合并、小于3月不分片
- **AC3**: 权限与鉴权（4个）- token 必填、Bearer 格式、API 成功、401 错误
- **AC4**: 可观测性指标（4个）- metrics 结构、请求统计、缓存命中率、分片统计
- **AC5**: 无数据返回 NO_DATA（2个）- 团队查询、用户查询
- **AC6**: 交互示例场景（6个）- 真实用户场景模拟（月度汇总、按天汇总、项目过滤、模糊匹配、多项目、人天矩阵）
- **AC7**: list_workloads PRD 参数（6个）- principal_type=user/project/work_item、report_by_id、参数校验
- **AC8**: MCP 业务错误 isError 语义（4个）- NO_DATA/USER_NOT_FOUND/unknown tool → isError=true、正常数据 → isError 不为 true
- **AC9**: Schema 一致性（3个）- group_by=type、filter_project_id 等声明与实现一致
- **AC10**: 聚合维度正确性（5个）- by_type 汇总、ISO 8601 周格式、跨年边界
- **AC11**: 输入参数与配置校验（3个）- TOKEN_MODE 警告、分页参数下限
- **AC12**: 查询性能与缓存（3个）- 少量用户逐用户过滤、缓存命中、缓存 TTL

## 单元 + E2E 测试覆盖 (136 个测试)

- **pagination** - 分页终止（maxPages/maxRecords/fetchError/timeout）、truncationReasons、去重
- **signalPropagation** - AbortSignal 透传、wall-clock 超时
- **metrics** - 指标快照、数据质量记录
- **cors** - Origin 校验、CORS 头
- **rateLimiter** - 令牌桶限流
- **timeUtils** - 日期解析、中文别名、时间分片
- **outputContract** - MCP 输出契约
- **structuredContent** - structuredContent 字段
- **schemaConsistency** - Zod schema 与 MCP inputSchema 一致性
- **isBusinessError** - 业务错误检测
- **workItemBatchCache** - 工作项批量缓存
- **zeroHourUsers** - 0 工时用户包含/排除
- **e2e-stdio** - stdio 传输端到端
- **mockE2E** - InMemoryTransport 全链路 E2E（list_users、user_work_summary、team_work_summary、get_work_item、list_workloads、builtin tools）

## HTTP 安全测试覆盖 (22 个测试)

- **SEC1** Origin 验证、**SEC2** CORS 头、**SEC3** API Key 鉴权
- **SEC4** 公开端点、**SEC5** API 超时与重试、**SEC6** Session 管理
- **SEC7** 请求解析与部署配置

## 执行步骤

### 快速验证（无网络依赖）

```bash
npm run build && npm run test:all
```

### 完整验证（包含真实 API 回归 + HTTP 安全）

```bash
npm run build
npm run test:all       # 136 unit/E2E tests
npm run test:http      # 22 HTTP security tests
node tests/regression.mjs  # 51 regression tests (需要 PINGCODE_TOKEN)
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
