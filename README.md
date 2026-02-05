# PingCode MCP Server

通过 MCP (Model Context Protocol) 让 AI 助手查询 PingCode 工时和工作项数据。支持自然语言查询团队/个人工时汇总、工作项明细等。

## 功能特性

### MCP 工具

| 工具 | 说明 |
|------|------|
| `user_work_summary` | 查询指定用户的工时汇总（支持按日/周/月/项目/工作项聚合） |
| `team_work_summary` | 查询团队工时汇总（支持人天矩阵、Top N 工作项） |
| `list_users` | 获取企业成员列表（支持分页、关键字搜索） |
| `list_workloads` | 获取工时明细（支持按用户/项目/工作项维度） |
| `get_work_item` | 获取工作项详情 |
| `get_metrics` | 获取服务运行指标 |
| `get_tool_versions` | 获取工具版本信息 |

### 核心能力

- **时间范围**：支持日期格式（`2026-01-01`）和中文别名（`上周`、`本月`）
- **自动分片**：超过 3 个月的查询自动分片聚合
- **多维度聚合**：按日/周/月/项目/工作项维度汇总
- **用户匹配**：支持按 ID 或姓名模糊匹配用户
- **版本化工具**：支持多版本并存、废弃警告、平滑升级

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```bash
# PingCode API
PINGCODE_TOKEN=your_bearer_token_here

# 运行模式
TRANSPORT_MODE=stdio   # stdio（本地）或 http（服务器）
```

### 3. 构建并运行

```bash
npm run build
npm start
```

## 部署方式

### 方式一：本地 stdio 模式

适用于 Claude Desktop 等本地 AI 客户端。

**Claude Desktop 配置** (`~/Library/Application Support/Claude/claude_desktop_config.json`)：

```json
{
  "mcpServers": {
    "pingcode": {
      "command": "node",
      "args": ["/path/to/pingcode-mcp/dist/index.js"],
      "env": {
        "PINGCODE_TOKEN": "your_token",
        "TRANSPORT_MODE": "stdio"
      }
    }
  }
}
```

### 方式二：HTTP 服务器模式

适用于服务器部署，多客户端共享。

```bash
# 使用 Docker Compose
PINGCODE_TOKEN=your_token docker-compose up -d
```

服务端点：
- MCP: `http://your-server:3000/mcp`
- 健康检查: `http://your-server:3000/health`
- 指标: `http://your-server:3000/metrics`

### 方式三：Nginx 反向代理 + 鉴权

适用于内网部署，需要统一鉴权。

1. 配置应用层 API Key：

```bash
MCP_API_KEY=your-secret-key
TRUST_PROXY=true
```

2. 参考 `docs/nginx-example.conf` 配置 Nginx：

```nginx
location /mcp {
    auth_basic "PingCode MCP";
    auth_basic_user_file /etc/nginx/.htpasswd;

    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_buffering off;  # SSE 支持
}
```

## 配置项

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `MOCK_MODE` | 使用模拟数据 | `false` |
| `PINGCODE_BASE_URL` | PingCode API 地址 | `https://open.pingcode.com` |
| `PINGCODE_TOKEN` | PingCode API Token | - |
| `TOKEN_MODE` | Token 类型 | `enterprise` |
| `TRANSPORT_MODE` | 传输模式 | `stdio` |
| `HTTP_PORT` | HTTP 端口 | `3000` |
| `MCP_API_KEY` | MCP API Key（可选） | - |
| `TRUST_PROXY` | 信任代理头 | `false` |
| `TIMEZONE` | 时区 | `Asia/Shanghai` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `NAME_MATCH_STRATEGY` | 姓名匹配策略 | `best` |

## 使用示例

### 查询个人工时

```
"张三上周做了什么？按天汇总，列出 Top 3 工作项"
```

AI 调用：
```json
{
  "tool": "user_work_summary",
  "arguments": {
    "user": { "name": "张三" },
    "time_range": { "start": "上周", "end": "上周" },
    "group_by": "day",
    "top_n": 3
  }
}
```

### 查询团队工时

```
"查 2026-01-01 到 2026-01-31，每个人工时多少，列出 Top 5 工作项"
```

AI 调用：
```json
{
  "tool": "team_work_summary",
  "arguments": {
    "time_range": { "start": "2026-01-01", "end": "2026-01-31" },
    "top_n": 5
  }
}
```

### 查询项目工时

```
"项目 A 这两周的工时，按人排序"
```

AI 调用：
```json
{
  "tool": "team_work_summary",
  "arguments": {
    "time_range": { "start": "上周", "end": "本周" },
    "project_id": "project_a_id",
    "group_by": "user"
  }
}
```

## 输出结构

### user_work_summary

```json
{
  "summary": {
    "user": { "id": "...", "name": "张三", "display_name": "张三" },
    "time_range": { "start_at": 1735689600, "end_at": 1738281600 },
    "total_hours": 40,
    "by_project": [{ "project": { "id": "...", "name": "项目A" }, "hours": 24 }],
    "by_work_item": [{ "work_item": { "id": "...", "identifier": "PROJ-123", "title": "功能开发" }, "hours": 16 }],
    "by_day": [{ "date": "2026-01-06", "hours": 8 }]
  },
  "details": [...],
  "data_quality": {
    "workloads_count": 20,
    "missing_work_item_count": 0,
    "time_sliced": false,
    "pagination_truncated": false,
    "details_truncated": false
  }
}
```

## 开发

```bash
# 开发模式
npm run dev

# 类型检查
npm run typecheck

# Mock 模式测试
MOCK_MODE=true npm start
```

## 技术栈

- **运行时**: Node.js 18+, TypeScript
- **MCP**: @modelcontextprotocol/sdk
- **验证**: Zod
- **日志**: Pino（按日期轮转）
- **时间处理**: date-fns, date-fns-tz

## 架构

```
src/
├── index.ts              # 入口，MCP Server 配置
├── config/               # 配置管理
├── api/
│   ├── client.ts         # PingCode API 客户端（重试、限流）
│   ├── endpoints/        # API 端点封装
│   └── types.ts          # API 类型定义
├── tools/
│   ├── versions.ts       # 工具版本管理
│   ├── registry.ts       # 工具注册
│   ├── userWorkSummary.ts
│   ├── teamWorkSummary.ts
│   └── ...
├── services/             # 业务逻辑层
├── cache/                # 缓存（内存）
├── server/
│   └── http.ts           # HTTP/SSE 服务器
├── utils/
│   ├── logger.ts         # 日志
│   ├── metrics.ts        # 指标统计
│   └── timeUtils.ts      # 时间处理
└── mock/                 # Mock 数据
```

## 非功能特性

| 特性 | 实现 |
|------|------|
| **性能** | 工作项缓存、批量获取、时间自动分片 |
| **可靠性** | 指数退避重试、速率限制 |
| **安全** | Token 日志脱敏、API Key 鉴权 |
| **可观测性** | 请求量/失败率/耗时/缓存命中率指标 |
| **兼容性** | 多版本工具、废弃警告机制 |

## License

MIT
