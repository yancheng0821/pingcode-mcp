# PingCode MCP Server

通过 MCP 让 AI 助手查询 PingCode 工时数据，支持自然语言查询。

> 详细架构设计、技术实现、API 说明见 [设计方案文档](pingcode-mcp-design.md)

## 快速部署

### 前置条件

- Node.js ≥ 20（[下载](https://nodejs.org/)）
- MCP 兼容客户端（如 [Claude Desktop](https://claude.ai/download)、Cursor、Continue 等）

### 1. 下载并安装

```bash
git clone https://github.com/yancheng0821/pingcode-mcp.git
cd pingcode-mcp
npm install
npm run build
```

### 2. 获取 PingCode Token

1. 登录 PingCode → 点右上角头像 → 管理后台 → 应用 → 凭据管理
2. 获取 `client_id` 和 `client_secret`，运行：

```bash
curl -s "https://open.pingcode.com/v1/auth/token?grant_type=client_credentials&client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET"
```

复制返回的 `access_token`（有效期约 30 天）。

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入 Token：

```bash
PINGCODE_TOKEN=你的access_token
TRANSPORT_MODE=stdio
```

### 4. 配置 MCP 客户端

> 支持任何 MCP 兼容客户端（如 Cursor、Continue 等），此处以 Claude Desktop 为例。

编辑配置文件：
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "pingcode": {
      "command": "node",
      "args": ["/你的路径/pingcode-mcp/dist/index.js"],
      "env": {
        "PINGCODE_TOKEN": "你的token",
        "TRANSPORT_MODE": "stdio"
      }
    }
  }
}
```

> 路径用绝对路径，在项目目录运行 `pwd` 获取。

### 5. 重启验证

重启 MCP 客户端（如 Claude Desktop），输入：`查询团队本月的工时汇总`

### 6. HTTP 部署（可选）

如需通过 HTTP 暴露 MCP 服务（例如网关/容器场景），可使用 `TRANSPORT_MODE=http`。

1. 配置环境变量（示例）：

```bash
PINGCODE_TOKEN=你的access_token
TRANSPORT_MODE=http
HTTP_PORT=3000
HTTP_HOST=127.0.0.1

# 二选一：单 key 或多 key
MCP_API_KEY=your-api-key
# MCP_API_KEYS=keyA:prod,keyB:staging

# 建议配置（浏览器/跨域场景）
ALLOWED_ORIGINS=https://your-app.example.com
```

2. 启动服务：

```bash
npm run build
npm run start
```

3. 健康检查：

```bash
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/metrics
```

4. MCP 调用示例（HTTP）：

```bash
curl -s http://127.0.0.1:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "jsonrpc":"2.0",
    "id":"1",
    "method":"tools/list",
    "params":{}
  }'
```

> 说明：
> - HTTP 模式必须配置 `MCP_API_KEY` 或 `MCP_API_KEYS`。
> - 若请求带 `Origin`，必须命中 `ALLOWED_ORIGINS` 白名单。
> - `TOKEN_MODE=user` 下，HTTP 会话初始化请求需携带 `X-User-Id`。

---

## 功能

| 工具 | 说明 |
|------|------|
| `user_work_summary` | 个人工时汇总（按日/周/月/项目/类型聚合） |
| `team_work_summary` | 团队工时汇总（Top N 工作项，含 0 工时成员） |
| `list_users` | 成员列表（带缓存，TTL 1h） |
| `list_workloads` | 工时明细（支持 filter_project_id） |
| `get_work_item` | 工作项详情 |
| `get_metrics` | 运行指标 |
| `get_tool_versions` | 工具版本信息 |

**特性**：中文时间别名（`上周`、`本月`）、超 3 月自动分片、ISO 8601 周计算、姓名模糊匹配、group_by=type 类型聚合

---

## 使用示例

```
"张三上周做了什么？列出 Top 3 工作项"
"查 2026-01-01 到 2026-01-31 团队工时，按人排序"
"项目 A 这两周的工时"
```

---

## 配置项

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PINGCODE_TOKEN` | API Token | **必填** |
| `TRANSPORT_MODE` | 传输模式 | `stdio` |
| `HTTP_PORT` | HTTP 端口 | `3000` |
| `HTTP_HOST` | HTTP 绑定地址 | `127.0.0.1` |
| `MCP_API_KEY` | API Key（HTTP 模式必填） | - |
| `ALLOWED_ORIGINS` | 允许的 Origin（逗号分隔） | 空（有 Origin 请求默认拒绝） |
| `TRUST_PROXY` | 信任反向代理头 | `false` |
| `HTTP_MAX_SESSIONS` | HTTP 最大并发 session 数 | `100` |
| `HTTP_SESSION_TTL_MS` | Session 空闲过期时间（ms） | `1800000` |
| `REQUEST_TIMEOUT` | API 请求超时（ms） | `15000` |
| `TIMEZONE` | 时区 | `Asia/Shanghai` |
| `NAME_MATCH_STRATEGY` | 姓名匹配策略 | `best` |
| `LOG_LEVEL` | 日志级别 | `info` |

> 注意：HTTP 模式下若请求带 `Origin` 头，必须配置 `ALLOWED_ORIGINS`；未配置时按 default-deny 拒绝（非浏览器无 `Origin` 请求不受影响）。

---

## 常见问题

**401 错误**：Token 过期，重新获取。

**ENOENT 错误**：路径配置错误，用 `pwd` 获取绝对路径。

**无反应**：检查 JSON 格式，完全退出重启客户端。

---

## 开发

```bash
npm run dev          # 开发模式
npm run test:unit    # 单元测试（Vitest，离线可跑）
npm test             # 回归测试（51 个用例）
npm run test:quiet   # 回归测试（过滤结构化日志）
npm run test:http    # HTTP 安全测试（22 个用例）
npm run typecheck    # 类型检查
```

## CI 门禁

仓库已配置 GitHub Actions（`.github/workflows/ci.yml`）：

- `push/pull_request`：自动执行 `typecheck`、`build`、`test:unit`、`test:http`
- `schedule`（每日 UTC 02:00）：执行 `tests/regression.mjs`（需配置 `PINGCODE_TOKEN` secret）

## 发布前检查清单

- [ ] 本地通过：`npm run typecheck`
- [ ] 本地通过：`npm run test:unit`
- [ ] 本地通过：`npm run test:http`
- [ ] 真实环境回归通过：`npm run test:quiet`
- [ ] CI `build-and-test` 绿灯
- [ ] 夜间回归任务可正常触发（已配置 `PINGCODE_TOKEN` secret）

## License

MIT
