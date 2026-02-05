# PingCode MCP Server 设计方案

> 日期：2026-02-05
> 状态：待实施

## 1. 概述

构建一个 MCP Server，让大模型能通过自然语言查询 PingCode 的工时和工作项数据。核心能力是按任意时间段查询"每个人在做什么（关联到哪些工作项/事项）以及工时是多少"。

### 1.1 技术选型

| 模块 | 选型 |
|-----|------|
| 技术栈 | TypeScript + Node.js |
| MCP SDK | @modelcontextprotocol/sdk |
| 缓存 | Redis 7 |
| 部署 | Docker Compose (Server + Redis) |
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
│  │                    Cache Layer (Redis)                 │ │
│  │   • 用户列表缓存 (TTL: 1h)  • 工作项详情缓存 (TTL: 6h)   │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    PingCode Open API                        │
│   /v1/directory/users  /v1/workloads  /v1/project/work_items│
└─────────────────────────────────────────────────────────────┘
```

**分层职责：**
- **MCP Tools Layer**：定义工具 schema，参数校验，调用 Service
- **Service Layer**：业务逻辑（分片、聚合、组装响应）
- **API Client**：封装 PingCode REST 调用，处理鉴权/重试/限流
- **Cache Layer**：Redis 缓存，减少重复请求

---

## 3. 项目结构

```
pingcode-mcp/
├── src/
│   ├── index.ts              # 入口，启动 MCP Server
│   ├── server.ts             # MCP Server 配置（stdio/HTTP 模式）
│   ├── tools/                # MCP Tools 定义
│   │   ├── userWorkSummary.ts
│   │   └── teamWorkSummary.ts
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
│   ├── cache/                # Redis 缓存封装
│   │   └── redis.ts
│   ├── utils/                # 工具函数
│   │   ├── timeUtils.ts      # 时间戳转换、分片逻辑
│   │   └── retry.ts          # 重试逻辑
│   └── config/               # 配置管理
│       └── index.ts
├── docker/
│   └── Dockerfile            # MCP Server 镜像
├── docker-compose.yml        # Server + Redis
├── .env.example              # 环境变量模板
├── package.json
├── tsconfig.json
└── README.md
```

---

## 4. 部署配置

### 4.1 docker-compose.yml

```yaml
version: '3.8'
services:
  pingcode-mcp:
    build:
      context: .
      dockerfile: docker/Dockerfile
    ports:
      - "3000:3000"          # HTTP/SSE 模式端口
    environment:
      - PINGCODE_TOKEN=${PINGCODE_TOKEN}
      - PINGCODE_BASE_URL=https://open.pingcode.com
      - REDIS_URL=redis://redis:6379
      - TRANSPORT_MODE=http  # stdio | http
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data

volumes:
  redis-data:
```

### 4.2 运行模式

- **本地开发/Claude Desktop**：`TRANSPORT_MODE=stdio`，通过标准输入输出通信
- **服务器部署**：`TRANSPORT_MODE=http`，暴露 HTTP+SSE 端口

---

## 5. MCP Tools 设计

> 对外同时暴露高层与基础工具，但推荐模型优先使用高层工具；当需要更细粒度控制或调试时再使用基础工具。

### 5.0 工具使用优先级

- 优先：`user_work_summary`、`team_work_summary`（稳定口径、自动分片、聚合完成）
- 兜底：`list_users`、`list_workloads`、`get_work_item`（需要手动聚合与口径对齐）

### 5.0.1 使用示例（高层优先，基础兜底）

- 示例 A：只需要标准报表  
  调用 `team_work_summary` 或 `user_work_summary`，直接获取 summary + details。
- 示例 B：需要自定义聚合维度  
  先 `list_users` 匹配用户 → `list_workloads` 拉明细 → 自行按需要聚合 → 必要时 `get_work_item` 丰富“在做什么”描述。

### 5.0.2 模型调用指引（建议放入系统提示或工具说明）

```text
优先使用 user_work_summary / team_work_summary。
仅在需要自定义聚合维度、调试或核对数据时，才调用 list_users / list_workloads / get_work_item。
如果出现用户姓名歧义，先返回候选列表请求确认，不要继续聚合。
时间范围超过 3 个月无需拆分，由高层工具自动分片。
```

### 5.1 Tool 1: `user_work_summary`

**用途**：查询单个用户在指定时间段内做了什么、工时多少

**输入参数 Schema：**
```typescript
{
  user: {
    id?: string;          // 用户 ID（二选一）
    name?: string;        // 用户姓名（模糊匹配）
  };
  time_range: {
    start: string;        // "2026-01-01" 或 "last_week"
    end: string;          // "2026-01-31" 或 "today"
  };
  group_by?: "day" | "week" | "month" | "work_item" | "project";  // 默认 "work_item"
  top_n?: number;         // 默认 10
}
```

**用户匹配规则：**
- strict: 仅允许唯一精确匹配，否则返回候选并停止
- best: 先精确匹配，再按包含关系/相似度选择最佳；多匹配则返回候选并停止
- prompt: 返回候选列表，等待上游确认

**输出结构：**
```typescript
{
  summary: {
    user: { id, name, display_name };
    time_range: { start_at, end_at };   // 实际查询的时间戳
    total_hours: number;
    by_project: [{ project: {id, name}, hours }];      // Top N
    by_work_item: [{ work_item: {id, identifier, title, project}, hours }];
    by_day?: [{ date, hours }];         // 当 group_by=day 时
  };
  details: [{
    date: string;
    workload_id: string;
    hours: number;
    work_item: { identifier, title, project };
    description?: string;
  }];
  data_quality: {
    workloads_count: number;
    missing_work_item_count: number;    // 无法解析的工作项数
    unknown_user_match: boolean;        // 用户名多匹配或未匹配
    time_sliced: boolean;               // 是否触发了分片查询
    pagination_truncated: boolean;      // 是否因分页限制导致截断
  };
}
```

### 5.2 Tool 2: `team_work_summary`

**用途**：查询团队在指定时间段内每个人做了什么、工时分布

**输入参数 Schema：**
```typescript
{
  time_range: {
    start: string;
    end: string;
  };
  user_ids?: string[];    // 不传则查全员
  project_id?: string;    // 可选：只看某项目
  group_by?: "user" | "project" | "work_item" | "day" | "week" | "month";  // 默认 "user"
  top_n?: number;         // 每人的 Top N 工作项，默认 5
}
```

**项目过滤规则：**
- 若 PingCode 支持 `principal_type=project`，则直接按项目拉取
- 若不支持，则按用户拉取后在聚合层过滤 `project_id`

**输出结构：**
```typescript
{
  summary: {
    time_range: { start_at, end_at };
    total_hours: number;              // 团队总工时
    user_count: number;
    members: [{
      user: { id, name, display_name };
      total_hours: number;
      top_projects: [{ project, hours }];
      top_work_items: [{ work_item, hours }];
    }];
  };
  by_day_matrix?: {                   // 可选：人天矩阵
    dates: string[];
    rows: [{ user, hours_per_day: number[] }];
  };
  data_quality: {
    workloads_count: number;
    unknown_user_matches: number;     // 团队内无法匹配的姓名数量
    time_sliced: boolean;
    pagination_truncated: boolean;
  };
}
```

---

## 6. 核心逻辑设计

### 6.1 时间处理与自动分片

```typescript
// 时间输入支持两种格式
type TimeInput = string;  // "2026-01-01" 或 "last_week" / "this_month" 等

// 时间口径约定
// - 时区：默认使用企业时区或配置的 TIMEZONE
// - 时间边界：start 为包含，end 为不包含 (half-open)
// - 输入日期若无时间，按 00:00:00 处理，end 会被归一到次日 00:00:00
// - 当 end 使用 "today/this_week/this_month" 这类动态范围时，end=now

// 自然语言转时间戳映射
const TIME_ALIASES = {
  "today": () => [startOfDay(now), now],
  "yesterday": () => [startOfDay(addDays(now, -1)), startOfDay(now)],
  "last_week": () => [startOfWeek(addWeeks(now, -1)), startOfWeek(now)],
  "this_week": () => [startOfWeek(now), now],
  "last_month": () => [startOfMonth(addMonths(now, -1)), startOfMonth(now)],
  "this_month": () => [startOfMonth(now), now],
};

// 分片逻辑（超过 3 个月自动拆分）
function splitTimeRange(start: number, end: number): Array<[number, number]> {
  const THREE_MONTHS = 90 * 24 * 60 * 60;  // 秒
  const chunks: Array<[number, number]> = [];

  let current = start;
  while (current < end) {
    const chunkEnd = Math.min(current + THREE_MONTHS, end);
    // half-open: [current, chunkEnd)
    chunks.push([current, chunkEnd]);
    current = chunkEnd;
  }
  return chunks;
}
```

### 6.2 数据获取流程

```
┌─────────────────────────────────────────────────────────────┐
│ 1. 解析输入                                                  │
│    • 用户名 → 调 list_users 匹配 → 获取 user_id             │
│    • 时间别名 → 转换为时间戳                                  │
└─────────────────────┬───────────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. 时间分片（如需要）                                         │
│    • 跨度 > 3个月 → 拆分为多个请求                            │
└─────────────────────┬───────────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. 并行获取工时数据                                          │
│    • 每个分片调用 GET /v1/workloads                          │
│    • 按 API 分页拉取，直到无更多数据                          │
│    • 结果去重（以 workload_id 为主键）                         │
│    • 合并所有分片结果                                         │
└─────────────────────┬───────────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. 批量获取工作项详情                                         │
│    • 提取所有 work_item_id                                   │
│    • 先查 Redis 缓存                                         │
│    • 缓存未命中的批量调 GET /v1/project/work_items/{id}      │
│    • 结果写入缓存 (TTL: 6h)                                   │
└─────────────────────┬───────────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. 聚合计算                                                  │
│    • 按 group_by 维度分组求和                                 │
│    • 排序取 Top N                                            │
│    • 组装 summary + details + data_quality                   │
└─────────────────────────────────────────────────────────────┘
```

### 6.3 缓存策略

| 数据类型 | Cache Key 格式 | TTL | 说明 |
|---------|---------------|-----|------|
| 用户列表 | `users:list` | 1h | 全员列表，变动少 |
| 用户详情 | `users:{id}` | 1h | 单个用户信息 |
| 工作项详情 | `work_items:{id}` | 6h | 标题/状态相对稳定 |
| 工时数据 | 不缓存 | - | 实时性要求高 |

### 6.4 错误处理与重试

```typescript
// 重试配置
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000,        // 1秒
  maxDelay: 10000,        // 最大 10秒
  retryableStatus: [429, 500, 502, 503, 504],
};

// 限流：每分钟 200 次（PingCode 限制）
const RATE_LIMIT = {
  maxRequests: 200,
  windowMs: 60 * 1000,
};

// 部分失败策略：
// - work_item 拉取失败：保留 workload 明细，work_item 置空并统计 missing_work_item_count
// - 分片失败：返回已成功分片结果，并标记 data_quality.time_sliced=true 且 pagination_truncated=true
// - 用户名多匹配：返回候选列表并停止聚合，unknown_user_match=true
```

### 6.5 接口分页与参数映射

- `GET /v1/workloads` 按 `page_index/page_size` 拉取，直到无更多数据或达到安全上限
- 安全上限：`MAX_PAGES`（默认 200）防止异常请求导致无限循环
- 达到 `MAX_PAGES` 时标记 `data_quality.pagination_truncated=true`
- 基础参数映射：
  - `principal_type=user` + `principal_id=user_id`：按用户拉工时
  - `principal_type=project` + `principal_id=project_id`：按项目拉工时（如支持）
  - `start_at/end_at`：秒级时间戳（half-open）

### 6.6 分页数据量预测

**假设条件：**
- 每页 `page_size = 100` 条
- 每人每天平均填报 2 条工时记录

**典型场景估算：**

| 场景 | 团队人数 | 查询跨度 | 预估记录数 | 所需页数 |
|-----|---------|---------|-----------|---------|
| 个人查 1 月 | 1 | 30 天 | 60 条 | 1 页 |
| 个人查 3 月 | 1 | 90 天 | 180 条 | 2 页 |
| 小团队查 1 月 | 10 | 30 天 | 600 条 | 6 页 |
| 中团队查 1 月 | 50 | 30 天 | 3,000 条 | 30 页 |
| 中团队查 3 月 | 50 | 90 天 | 9,000 条 | 90 页 |
| 大团队查 1 月 | 100 | 30 天 | 6,000 条 | 60 页 |
| 大团队查 3 月 | 100 | 90 天 | 18,000 条 | 180 页 |

**结论：** `MAX_PAGES=200`（20,000 条）可覆盖 100 人团队查 3 个月的场景

---

## 7. 配置管理

### 7.1 环境变量

```bash
# === PingCode API ===
PINGCODE_BASE_URL=https://open.pingcode.com
PINGCODE_TOKEN=your_bearer_token_here
TOKEN_MODE=enterprise          # enterprise | user

# === Redis ===
REDIS_URL=redis://localhost:6379
CACHE_TTL_USERS=3600           # 1小时（秒）
CACHE_TTL_WORK_ITEMS=21600     # 6小时（秒）

# === Server ===
TRANSPORT_MODE=stdio           # stdio | http
HTTP_PORT=3000                 # HTTP 模式端口

# === Rate Limit ===
RATE_LIMIT_PER_MIN=200         # PingCode API 限制

# === Pagination ===
MAX_PAGES=200                  # 防止异常分页，支持约 20,000 条记录

# === Timezone ===
TIMEZONE=Asia/Shanghai         # 企业默认时区

# === Name Matching ===
NAME_MATCH_STRATEGY=best       # best | strict | prompt

# === Logging ===
LOG_LEVEL=info                 # debug | info | warn | error
```

### 7.2 配置加载优先级

```
1. 环境变量（最高优先级）
2. .env 文件
3. 默认值（代码内置）
```

---

## 8. 可观测性

### 8.1 日志设计

```typescript
// 日志格式（JSON）
{
  "timestamp": "2026-02-05T10:30:00Z",
  "level": "info",
  "service": "pingcode-mcp",
  "event": "api_request",
  "data": {
    "endpoint": "/v1/workloads",
    "duration_ms": 230,
    "status": 200,
    "cache_hit": false
  }
}
```

**关键日志点：**
- MCP Tool 调用（入参、耗时、结果摘要）
- PingCode API 请求（endpoint、耗时、状态码）
- 缓存命中/未命中
- 错误和重试
- 时间分片触发
- 分页次数与截断标记
- 用户名匹配歧义

### 8.2 敏感信息保护

- `PINGCODE_TOKEN` 不写入日志
- 错误响应不暴露内部堆栈
- `.env` 文件加入 `.gitignore`

---

## 9. 验收标准

### AC1：团队时间段查询
- 输入：`start/end`（<=3个月）、不指定 user_ids
- 输出：包含全员列表、每人 total_hours、每人 Top work items/projects
- 明细可追溯到 workload_id

### AC2：跨度超 3 个月
- 输入：`start/end` 超 3 个月
- 系统自动分片调用，输出合并后的 totals
- `data_quality.time_sliced=true` 标记

### AC3：权限与鉴权
- 未提供 token：返回标准错误（401/配置错误）
- 使用 Bearer token 调用 PingCode API

---

## 10. 后续步骤

1. 初始化项目（package.json、tsconfig.json）
2. 实现 PingCode API Client
3. 实现 Redis 缓存层
4. 实现 Service 层
5. 实现 MCP Tools
6. Docker 配置
7. 测试与文档
