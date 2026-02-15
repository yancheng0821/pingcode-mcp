# PingCode MCP Server - 项目上下文

> 此文件为 Claude Code 提供项目上下文，避免每次会话都需要扫描整个项目。

## 项目概述

PingCode MCP Server 是一个通过 MCP (Model Context Protocol) 协议让 AI 助手查询 PingCode 工时和工作项数据的服务。支持自然语言查询团队/个人工时汇总、工作项明细等。

**技术栈**：TypeScript + Node.js 18+ + MCP SDK + Zod + Pino

## 目录结构

```
src/
├── index.ts                 # 入口，MCP Server 配置
├── config/index.ts          # 配置管理（环境变量）
├── api/
│   ├── client.ts            # PingCode API 客户端（重试、限流）
│   ├── types.ts             # API 类型定义
│   └── endpoints/           # API 端点封装
│       ├── users.ts         # 用户列表
│       ├── workloads.ts     # 工时记录（含时间分片）
│       └── workItems.ts     # 工作项详情
├── tools/
│   ├── versions.ts          # 工具版本管理核心
│   ├── registry.ts          # 工具注册入口
│   ├── userWorkSummary.ts   # 用户工时汇总工具
│   ├── teamWorkSummary.ts   # 团队工时汇总工具
│   ├── listUsers.ts         # 用户列表工具
│   ├── listWorkloads.ts     # 工时列表工具
│   └── getWorkItem.ts       # 工作项详情工具
├── services/
│   ├── userService.ts       # 用户业务逻辑
│   ├── workloadService.ts   # 工时业务逻辑（聚合计算）
│   └── workItemService.ts   # 工作项业务逻辑
├── cache/
│   ├── index.ts             # 缓存入口
│   └── memory.ts            # 内存缓存实现
├── server/
│   └── http.ts              # HTTP/SSE 服务器（含鉴权）
└── utils/
    ├── logger.ts            # Pino 日志（按日期轮转）
    ├── metrics.ts           # 指标统计
    └── timeUtils.ts         # 时间处理（中文别名、分片）
```

## MCP 工具列表

| 工具名 | 文件 | 说明 |
|--------|------|------|
| `user_work_summary` | tools/userWorkSummary.ts | 查询用户工时汇总 |
| `team_work_summary` | tools/teamWorkSummary.ts | 查询团队工时汇总 |
| `list_users` | tools/listUsers.ts | 获取用户列表 |
| `list_workloads` | tools/listWorkloads.ts | 获取工时明细 |
| `get_work_item` | tools/getWorkItem.ts | 获取工作项详情 |
| `get_metrics` | tools/registry.ts | 获取服务指标（内置） |
| `get_tool_versions` | tools/registry.ts | 获取工具版本（内置） |

## 关键设计

### 1. 工具版本管理 (tools/versions.ts)

```typescript
toolRegistry.register('user_work_summary', 'v1', {
  status: 'current',  // current | supported | deprecated | removed
  handler: ...,
  inputSchema: ...,
});
```

- 支持多版本并存
- 别名机制：`user_work_summary` → `user_work_summary_v1`
- 废弃警告：调用 deprecated 版本返回 warnings

### 2. 时间处理 (utils/timeUtils.ts)

- 支持日期格式：`2026-01-01`、`2026/01/01`
- 支持中文别名：`今天`、`昨天`、`上周`、`本周`、`上月`、`本月`
- 自动分片：超过 3 个月的查询自动拆分

### 3. API 客户端 (api/client.ts)

- 指数退避重试：[429, 500, 502, 503, 504]
- 速率限制：默认 200 次/分钟
- Token 鉴权：Bearer token

### 4. HTTP 鉴权 (server/http.ts + index.ts)

- **HTTP 模式强制要求 API Key**（启动时检查，见 index.ts）
- 支持 `Authorization: Bearer <key>` 或 `X-API-Key: <key>`
- 端点：`/mcp`（需鉴权）、`/health`（无需）、`/metrics`（无需）
- 信任代理头：`X-Forwarded-For`、`X-Real-IP`

### 5. 指标统计 (utils/metrics.ts)

```typescript
metrics.getSnapshot() → {
  uptime_seconds,
  requests: { total, errors, error_rate, by_endpoint },
  cache: { hits, misses, hit_rate },
  time_slicing: { sliced_requests, total_slices },
  retries: { total_retries, rate_limit_exhausted },
  data_quality: { total_responses, pagination_truncated, details_truncated, time_sliced, truncation_rate }
}
```

## 配置项 (.env)

```bash
# 必填
PINGCODE_TOKEN=xxx
MCP_API_KEY=xxx          # HTTP 模式必填，stdio 模式可选

# 可选
TRANSPORT_MODE=stdio|http
HTTP_PORT=3000
TRUST_PROXY=false
TIMEZONE=Asia/Shanghai
LOG_LEVEL=info
NAME_MATCH_STRATEGY=best|strict|prompt
TRUNCATION_ALERT_THRESHOLD=0.3  # 截断率超过此阈值时产生强警告 (0-1)
```

**注意**：HTTP 模式强制要求 `MCP_API_KEY`，否则启动失败。

## 常用命令

```bash
npm install          # 安装依赖
npm run build        # 构建
npm start            # 运行
npm run dev          # 开发模式
npm run typecheck    # 类型检查

# HTTP 模式
TRANSPORT_MODE=http npm start
```

## 需求文档

详见 `Pingcode-MCP需求PRD.md`

## 工具命名约定

- 现有工具使用扁平名称（`list_users`、`user_work_summary` 等），保持不变以避免破坏性变更
- 未来新增工具使用 `pingcode_` 前缀（如 `pingcode_list_sprints`）
- 理由：当前服务器通常独立运行，扁平名称不会冲突；加前缀的收益不抵重命名迁移成本

## 注意事项

1. **不缓存用户列表**：确保能查到新加入的员工（见 api/endpoints/users.ts）
2. **工作项缓存**：TTL 6 小时（见 config/index.ts）
3. **时区**：默认 `Asia/Shanghai`，影响日期格式化
4. **日志文件**：`logs/app-YYYY-MM-DD.log`（按日期轮转）
