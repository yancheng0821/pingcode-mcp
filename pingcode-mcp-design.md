# PingCode MCP Server 设计方案

> 日期：2026-02-15
> 状态：已实施（P0/P1/P2 修复完成，73 个测试全部通过）

## 1. 概述

构建一个 MCP Server，让大模型能通过自然语言查询 PingCode 的工时和工作项数据。核心能力是按任意时间段查询"每个人在做什么（关联到哪些工作项/事项）以及工时是多少"。

### 1.1 技术选型

| 模块 | 选型 |
|-----|------|
| 技术栈 | TypeScript + Node.js |
| MCP SDK | @modelcontextprotocol/sdk |
| 缓存 | 内存缓存（可扩展 Redis） |
| 部署 | Docker Compose / 本地运行 |
| 传输模式 | stdio (本地) / HTTP+SSE (服务器) |

### 1.2 设计原则

- 工具返回结构稳定、口径一致
- 高层工具优先，基础工具兜底
- 基础能力实现与对外暴露解耦（默认可对外暴露基础工具）
- 自动处理时间分片（>3个月）
- 缓存减少重复请求

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      MCP Clients                            │
│         (Claude Desktop / Cursor / 其他 AI 工具)             │
└─────────────────────┬───────────────────────────────────────┘
                      │ MCP Protocol
                      │ (stdio 本地 / HTTP+SSE 服务器)
┌─────────────────────▼───────────────────────────────────────┐
│                  PingCode MCP Server                        │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                    MCP Tools Layer                     │ │
│  │   • user_work_summary    • team_work_summary           │ │
│  │   • list_users           • list_workloads              │ │
│  │   • get_work_item        • get_metrics                 │ │
│  └────────────────────────────┬───────────────────────────┘ │
│  ┌────────────────────────────▼───────────────────────────┐ │
│  │                 Tool Version Registry                  │ │
│  │   • 多版本并存  • 废弃警告  • 平滑升级                    │ │
│  └────────────────────────────┬───────────────────────────┘ │
│  ┌────────────────────────────▼───────────────────────────┐ │
│  │                   Service Layer                        │ │
│  │   • UserService  • WorkloadService  • WorkItemService  │ │
│  │   • 时间分片逻辑  • 数据聚合逻辑                          │ │
│  └────────────────────────────┬───────────────────────────┘ │
│  ┌────────────────────────────▼───────────────────────────┐ │
│  │                 PingCode API Client                    │ │
│  │   • REST 请求封装  • 重试/限流  • 响应映射               │ │
│  └────────────────────────────┬───────────────────────────┘ │
│  ┌────────────────────────────▼───────────────────────────┐ │
│  │                    Cache Layer                         │ │
│  │   • 用户列表缓存 (TTL: 1h)  • 工作项详情缓存 (TTL: 6h)   │ │
│  └────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                  Observability                         │ │
│  │   • Metrics  • Logger  • 敏感信息脱敏                   │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    PingCode Open API                        │
│   /v1/directory/users  /v1/workloads  /v1/project/work_items│
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 项目结构

```
pingcode-mcp/
├── src/
│   ├── index.ts              # 入口，启动 MCP Server
│   ├── tools/                # MCP Tools 定义
│   │   ├── versions.ts       # 工具版本管理
│   │   ├── registry.ts       # 工具注册入口
│   │   ├── userWorkSummary.ts
│   │   ├── teamWorkSummary.ts
│   │   ├── listUsers.ts
│   │   ├── listWorkloads.ts
│   │   └── getWorkItem.ts
│   ├── services/             # 业务逻辑层
│   │   ├── userService.ts
│   │   ├── workloadService.ts
│   │   └── workItemService.ts
│   ├── api/                  # PingCode API Client
│   │   ├── client.ts         # HTTP 客户端封装
│   │   ├── types.ts          # API 响应类型定义
│   │   └── endpoints/        # 各接口封装
│   │       ├── users.ts
│   │       ├── workloads.ts
│   │       └── workItems.ts
│   ├── cache/                # 缓存封装
│   │   ├── index.ts          # 缓存接口
│   │   └── memory.ts         # 内存缓存实现
│   ├── server/
│   │   ├── mcp.ts            # MCP Server 创建与工具注册
│   │   └── http.ts           # HTTP/SSE 服务器（鉴权、Origin 校验、Session 管理）
│   ├── utils/                # 工具函数
│   │   ├── timeUtils.ts      # 时间戳转换、分片逻辑
│   │   ├── logger.ts         # 日志（含脱敏）
│   │   └── metrics.ts        # 可观测性指标
│   └── config/               # 配置管理
│       └── index.ts
├── tests/
│   ├── regression.mjs        # 回归测试（51 个用例）
│   └── http-security.mjs     # HTTP 安全与部署测试（22 个用例）
├── docker/
│   └── Dockerfile            # MCP Server 镜像
├── docker-compose.yml
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## 4. 技术实现详解

### 4.1 可靠性：网络错误重试（指数退避）

**实现位置**：`src/api/client.ts`

```typescript
const RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,           // 最多重试 3 次
  baseDelay: 1000,         // 基础延迟 1 秒
  maxDelay: 10000,         // 最大延迟 10 秒
  retryableStatus: [429, 500, 502, 503, 504],  // 可重试的状态码
};

// 指数退避算法
const delay = Math.min(
  RETRY_CONFIG.baseDelay * Math.pow(2, attempt),  // 2^attempt 指数增长
  RETRY_CONFIG.maxDelay                            // 但不超过最大值
);
```

**延迟序列**：

| 重试次数 | 计算 | 实际延迟 |
|---------|------|---------|
| 第 1 次 | 1000 × 2^0 = 1000ms | 1s |
| 第 2 次 | 1000 × 2^1 = 2000ms | 2s |
| 第 3 次 | 1000 × 2^2 = 4000ms | 4s |

**防止请求放大机制**：

| 机制 | 作用 |
|------|------|
| maxRetries 限制 | 最多重试 3 次，总共 4 次请求 |
| 指数退避 | 延迟递增，减少瞬时压力 |
| maxDelay 上限 | 防止无限等待 |
| Rate Limiter | 全局限流 200/min |
| 可重试状态码白名单 | 只对临时性错误重试 |
| AbortController 超时 | 单次请求超过 `REQUEST_TIMEOUT`（默认 15s）自动取消 |
| 429 Retry-After | 尊重服务端返回的 `Retry-After` 头，避免盲目重试 |

### 4.2 兼容性：工具版本管理

**实现位置**：`src/tools/versions.ts`

```typescript
// 版本状态
type VersionStatus = 'current' | 'supported' | 'deprecated' | 'removed';

// 工具版本注册
toolRegistry.register('user_work_summary', 'v1', {
  status: 'current',
  handler: userWorkSummary,
  inputSchema: UserWorkSummaryInputSchema,
  definition: userWorkSummaryToolDefinition,
});
```

**调用方式兼容**：

```
user_work_summary      → 调用 current 版本 (v1)
user_work_summary_v1   → 显式调用 v1
user_work_summary_v2   → 显式调用 v2 (如果存在)
```

**升级路径示例**：

```
阶段 1: 发布 v2
├── v1: status='current' (仍为默认)
└── v2: status='supported' (可显式调用)

阶段 2: 切换默认
├── v1: status='deprecated', removalDate='2026-06-01'
└── v2: status='current' (成为默认)

阶段 3: 移除 v1
├── v1: status='removed'
└── v2: status='current'
```

### 4.3 可观测性：指标统计

**实现位置**：`src/utils/metrics.ts`

```typescript
interface MetricsSnapshot {
  uptime_seconds: number;
  requests: {
    total: number;
    errors: number;
    error_rate: number;
    by_endpoint: Record<string, RequestStats>;
  };
  cache: {
    hits: number;
    misses: number;
    hit_rate: number;
  };
  time_slicing: {
    sliced_requests: number;
    total_slices: number;
    avg_slices_per_request: number;
  };
}
```

**指标采集点**：

| 指标 | 采集位置 | 说明 |
|------|---------|------|
| 请求量 | `api/client.ts` | 每次 API 调用 |
| 失败率 | `api/client.ts` | HTTP 错误响应 |
| 平均耗时 | `api/client.ts` | 请求开始到结束 |
| 缓存命中率 | `cache/memory.ts` | get 操作 |
| 分片次数 | `api/endpoints/workloads.ts` | 时间分片触发 |

### 4.4 时间自动分片

**实现位置**：`src/api/endpoints/workloads.ts`

```typescript
// 超过 3 个月自动拆分
const THREE_MONTHS_SECONDS = 90 * 24 * 60 * 60;

function splitTimeRange(startAt: number, endAt: number): TimeChunk[] {
  const chunks: TimeChunk[] = [];
  let current = startAt;

  while (current < endAt) {
    const chunkEnd = Math.min(current + THREE_MONTHS_SECONDS, endAt);
    chunks.push({ startAt: current, endAt: chunkEnd });
    current = chunkEnd;
  }

  return chunks;
}
```

### 4.5 工时 API 接口

**实现位置**：`src/api/endpoints/workloads.ts`、`src/tools/listWorkloads.ts`

**使用接口**：`GET /v1/workloads`（非 `/v1/project/workloads`）

#### PRD 参数设计（Tool 层）

MCP Tool `list_workloads` 暴露的参数遵循 PRD 定义：

| principal_type | principal_id | 含义 | 内部转换 |
|----------------|--------------|------|----------|
| `user` | 用户 ID | 按用户查询 | → `report_by_id` |
| `project` | 项目 ID | 按项目查询 | → `pilot_id` |
| `work_item` | 工作项 ID | 按工作项查询 | → API 原生参数 |

#### API 底层参数

PingCode `/v1/workloads` API 支持的过滤参数：

| 参数 | 说明 | 示例 |
|------|------|------|
| `start_at` / `end_at` | 时间范围（必填） | Unix 时间戳 |
| `report_by_id` | 按填报人过滤 | 用户 ID |
| `pilot_id` | 按项目过滤（需配合 principal_type） | 项目 ID |
| `principal_type` + `principal_id` | 按主体过滤 | `work_item` + 工作项 ID |

**API 原生 principal_type 枚举值**：
- `work_item` - 工作项
- `idea` - 想法（需要 Ideas 模块权限）
- `test_case` - 用例（需要 Testhub 模块权限）

**注意事项**：
- PRD 定义的 `principal_type=user/project` 由 Tool 层转换为 API 参数
- 工时响应中不直接包含项目信息，需通过关联的工作项获取

### 4.6 缓存策略

**实现位置**：`src/cache/memory.ts`

| 数据类型 | Cache Key 格式 | TTL | 说明 |
|---------|---------------|-----|------|
| 用户列表 | `users:list` | 1h (`CACHE_TTL_USERS`) | 全员列表，已实现 |
| 用户详情 | `users:{id}` | 1h | 单个用户信息 |
| 工作项详情 | `work_items:{id}` | 6h (`CACHE_TTL_WORK_ITEMS`) | 标题/状态相对稳定 |
| 工时数据 | 不缓存 | - | 实时性要求高 |

### 4.7 权限与鉴权

**PingCode API 鉴权**：`src/api/client.ts`

```typescript
headers: {
  'Authorization': `Bearer ${this.token}`,
  'Content-Type': 'application/json',
}
```

**Token 配置校验**：`src/config/index.ts`

```typescript
token: z.string().min(1, 'PINGCODE_TOKEN is required'),
```

**HTTP 模式安全**：`src/server/http.ts`

- API Key 鉴权：支持 `Authorization: Bearer <key>` 或 `X-API-Key: <key>`
- 未配置 MCP_API_KEY 时拒绝启动 HTTP 模式
- Origin 校验：通过 `ALLOWED_ORIGINS` 配置防 DNS rebinding（未配置时向后兼容放行）
- CORS：动态反射受信 Origin，Allow-Headers 包含 `X-API-Key`、`MCP-Protocol-Version`
- 默认绑定 `127.0.0.1`，需通过 `HTTP_HOST=0.0.0.0` 显式暴露到网络
- Session 管理：上限 `HTTP_MAX_SESSIONS`（默认 100），空闲超时 `HTTP_SESSION_TTL_MS`（默认 30 分钟）
- 每个 HTTP session 创建独立的 MCP Server 实例（SDK 要求）
- 非法 JSON 请求体返回 400（非静默吞错）
- 支持 DELETE /mcp 主动终止 session

---

## 5. MCP Tools 设计

### 5.1 工具列表

| 工具 | 版本 | 说明 |
|------|------|------|
| `user_work_summary` | v1 | 查询单个用户工时汇总 |
| `team_work_summary` | v1 | 查询团队工时汇总 |
| `list_users` | v1 | 获取用户列表 |
| `list_workloads` | v1 | 获取工时明细 |
| `get_work_item` | v1 | 获取工作项详情 |
| `get_metrics` | v1 | 获取运行指标（内置） |
| `get_tool_versions` | v1 | 获取版本信息（内置） |

### 5.2 使用优先级

```text
优先使用 user_work_summary / team_work_summary。
仅在需要自定义聚合维度、调试或核对数据时，才调用 list_users / list_workloads / get_work_item。
如果出现用户姓名歧义，先返回候选列表请求确认，不要继续聚合。
时间范围超过 3 个月无需拆分，由高层工具自动分片。
```

### 5.3 交互示例

| 用户问题 | 调用工具 |
|---------|---------|
| "帮我查 2026-01-01 到 2026-01-31，每个人做了什么，工时分别多少，并列出每人 Top 5 工作项" | `team_work_summary(time_range={start, end}, top_n=5)` |
| "张三上周做了什么？按天汇总，每天多少工时；再列出投入最多的 3 个工作项" | `user_work_summary(user={name: "张三"}, group_by="day", top_n=3)` |
| "项目 GDY 这两周的工时分布，按人排序" | `team_work_summary(project_id=xxx, group_by="user")` |

---

## 6. 验收标准

### AC1：团队时间段查询 ✅

- 输入：`start/end`（<=3个月）、不指定 user_ids
- 输出：包含全员列表、每人 total_hours、每人 Top work items/projects
- 明细可追溯到 workload_id；work_item 解析到 identifier/title

### AC2：跨度超 3 个月 ✅

- 输入：`start/end` 超 3 个月
- 系统自动分片调用，输出合并后的 totals
- `data_quality.time_sliced=true` 标记

### AC3：权限与鉴权 ✅

- 未提供 token：返回标准错误（配置校验失败）
- 使用 Bearer token 调用 PingCode API
- 无效 token 返回 401 错误

### AC4：可观测性指标 ✅

- `get_metrics` 返回正确结构
- 请求后指标更新
- 缓存命中率统计
- 分片统计

### AC5：无数据返回 NO_DATA ✅

- 团队/用户查询无数据时返回 `code: 'NO_DATA'`
- 不返回空结果让模型编造数据

### AC6：交互示例场景 ✅

- 团队月度汇总 + Top 5 工作项
- 用户按天汇总 + Top N 工作项
- 按项目过滤 + 按人排序
- 用户名模糊匹配
- 多项目工时汇总
- 人天矩阵

### AC7：list_workloads PRD 参数 ✅

- 验证使用 `/v1/workloads` 接口
- principal_type=user/project/work_item 各场景
- report_by_id 兼容参数
- principal_type 和 principal_id 必须同时提供

### AC8：MCP 业务错误 isError 语义 ✅

- NO_DATA / USER_NOT_FOUND 业务错误标记 `isError: true`
- 正常数据 `isError` 不为 true
- unknown tool 返回 `isError: true`

### AC9：Schema 一致性 ✅

- user_work_summary / team_work_summary JSON Schema 包含 `group_by=type`
- list_workloads JSON Schema 包含 `filter_project_id`

### AC10：聚合维度正确性 ✅

- group_by=type 用户/团队汇总返回 `by_type` 字段
- group_by=week 返回 ISO 8601 周格式（YYYY-WNN）
- ISO 周跨年边界正确性（first-Thursday 算法）

### AC11：输入参数与配置校验 ✅

- 未实现的 TOKEN_MODE 启动时给出警告
- list_users 分页参数 page_index / page_size 不接受 < 1

### AC12：查询性能与缓存 ✅

- 批量工时查询少量用户走逐用户服务端过滤
- 用户列表第二次查询命中缓存
- 用户列表缓存使用配置的 TTL

---

## 7. 回归测试

**测试文件**：`tests/regression.mjs`

**运行方式**：
```bash
npm run test        # 回归测试（51 个用例，需要 PINGCODE_TOKEN）
npm run test:http   # HTTP 安全测试（22 个用例，使用 Mock 服务器）
npm run typecheck   # TypeScript 类型检查
```

**回归测试覆盖（51 个用例）**：

| 分组 | 测试数 | 说明 |
|------|--------|------|
| AC1 | 8 | 团队时间段查询（含 0 工时用户、项目过滤、missing_count） |
| AC2 | 3 | 自动分片 |
| AC3 | 4 | 权限鉴权 |
| AC4 | 4 | 可观测性 |
| AC5 | 2 | NO_DATA 处理 |
| AC6 | 6 | 交互场景 |
| AC7 | 6 | list_workloads PRD 参数 |
| AC8 | 4 | MCP 业务错误 isError 语义 |
| AC9 | 3 | Schema 一致性（Zod vs JSON Schema） |
| AC10 | 5 | 聚合维度（ISO 周、group_by=type） |
| AC11 | 3 | 输入参数与配置校验 |
| AC12 | 3 | 查询性能与缓存 |

**HTTP 安全测试覆盖（22 个用例，`tests/http-security.mjs`）**：

| 分组 | 测试数 | 说明 |
|------|--------|------|
| SEC1 | 3 | Origin 验证（防 DNS rebinding） |
| SEC2 | 3 | CORS 头（反射 Origin、预检、Expose） |
| SEC3 | 4 | API Key 鉴权（Bearer / X-API-Key） |
| SEC4 | 4 | 公开端点（/health、/metrics、404） |
| SEC5 | 2 | API 超时与 429 Retry-After |
| SEC6 | 3 | Session 管理（上限 503、TTL 过期、DELETE） |
| SEC7 | 3 | 请求解析与部署配置 |

---

## 8. 配置项

```bash
# === PingCode API ===
PINGCODE_BASE_URL=https://open.pingcode.com
PINGCODE_TOKEN=your_bearer_token_here
TOKEN_MODE=enterprise          # enterprise | user（user 尚未实现）

# === Server ===
TRANSPORT_MODE=stdio           # stdio | http
HTTP_PORT=3000                 # HTTP 模式端口
HTTP_HOST=127.0.0.1            # 绑定地址（0.0.0.0 暴露到网络）
HTTP_MAX_SESSIONS=100          # 最大并发 session 数
HTTP_SESSION_TTL_MS=1800000    # Session 空闲过期时间（30 分钟）

# === Auth (HTTP 模式) ===
MCP_API_KEY=                   # HTTP 模式必填
TRUST_PROXY=false              # 信任反向代理头（X-Forwarded-For / X-Real-IP）
ALLOWED_ORIGINS=               # 允许的 Origin 列表，逗号分隔（防 DNS rebinding）

# === API Client ===
REQUEST_TIMEOUT=15000          # 单次 API 请求超时（ms）
RATE_LIMIT_PER_MIN=200         # PingCode API 限流

# === Cache ===
CACHE_TTL_USERS=3600           # 用户列表缓存 TTL（秒，默认 1h）
CACHE_TTL_WORK_ITEMS=21600     # 工作项缓存 TTL（秒，默认 6h）

# === Timezone ===
TIMEZONE=Asia/Shanghai         # 企业默认时区

# === Name Matching ===
NAME_MATCH_STRATEGY=best       # best | strict | prompt

# === Logging ===
LOG_LEVEL=info                 # debug | info | warn | error
```
