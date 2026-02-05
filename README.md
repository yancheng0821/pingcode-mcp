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

---

## 功能

| 工具 | 说明 |
|------|------|
| `user_work_summary` | 个人工时汇总（按日/周/月/项目聚合） |
| `team_work_summary` | 团队工时汇总（Top N 工作项） |
| `list_users` | 成员列表 |
| `list_workloads` | 工时明细 |
| `get_metrics` | 运行指标 |

**特性**：中文时间别名（`上周`、`本月`）、超 3 月自动分片、姓名模糊匹配

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
| `MCP_API_KEY` | API Key（HTTP 模式） | - |
| `TIMEZONE` | 时区 | `Asia/Shanghai` |

---

## 常见问题

**401 错误**：Token 过期，重新获取。

**ENOENT 错误**：路径配置错误，用 `pwd` 获取绝对路径。

**无反应**：检查 JSON 格式，完全退出重启客户端。

---

## 开发

```bash
npm run dev      # 开发模式
npm test         # 运行测试
npm run typecheck
```

## License

MIT
