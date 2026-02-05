# PingCode MCP 项目进度汇总

**更新时间：** 2026-02-05

## 项目概述
为 PingCode 构建 MCP Server，让 AI 助手通过自然语言查询工时和工作项数据。

## 已完成功能

### 1. 核心架构
- TypeScript + Node.js 技术栈
- MCP SDK 集成（支持 stdio 和 HTTP 两种模式）
- Zod 配置验证
- Pino 日志（每日轮转，保留 30 天）

### 2. 两个 MCP 工具
- `user_work_summary` - 查询单个用户工时
- `team_work_summary` - 查询团队工时

### 3. API 层
- PingCode REST Client（`src/api/client.ts`）
- 用户、工时、工作项 API 封装

### 4. 缓存
- 内存缓存（已移除 Redis 依赖，简化部署）

### 5. Mock 模式
- 支持无真实 Token 情况下测试
- 模拟用户、工作项、工时数据

### 6. 部署支持
- Docker Compose 配置
- `.env` 配置文件
- `.gitignore`、`README.md`

## 已修复的问题
1. ~~ESLint 版本冲突~~ → 降级到 eslint@8
2. ~~Node.js 版本过低~~ → Claude Desktop 配置指定 Node 20
3. ~~日志干扰 stdio 通信~~ → 日志输出到 stderr
4. ~~getWorkItemsBatch 未检查 mock 模式~~ → 已修复
5. ~~缺少 dotenv~~ → 已添加

## 当前状态
- 构建通过 ✓
- Claude Desktop 连接成功 ✓
- Mock 模式工作正常 ✓
- 日志文件输出正常 ✓

## GitHub 仓库
https://github.com/yancheng0821/pingcode-mcp

## 待处理
- 代码尚未提交到 GitHub
- Claude Desktop 中文显示乱码（客户端问题，非代码问题）

## Claude Desktop 配置
```json
{
  "mcpServers": {
    "pingcode": {
      "command": "/Users/aisenyc/.nvm/versions/node/v20.19.5/bin/node",
      "args": ["/Users/aisenyc/pingcode-mcp/dist/index.js"],
      "env": {
        "PINGCODE_TOKEN": "mock_token",
        "TRANSPORT_MODE": "stdio",
        "MOCK_MODE": "true"
      }
    }
  }
}
```

## 关键文件路径
```
/Users/aisenyc/pingcode-mcp/
├── src/
│   ├── index.ts          # 入口
│   ├── config/           # 配置
│   ├── api/              # PingCode API
│   ├── cache/memory.ts   # 内存缓存
│   ├── tools/            # MCP 工具
│   ├── services/         # 业务逻辑
│   ├── mock/             # 模拟数据
│   └── utils/            # 工具函数
├── logs/                 # 日志目录
├── docs/plans/           # 设计文档
└── docker-compose.yml
```

## 启动命令

```bash
# 构建
npm run build

# 运行（使用 .env 配置）
npm start

# 开发模式
npm run dev
```

## 下一步可做的事情
1. 提交代码到 GitHub
2. 获取真实 PingCode Token 进行测试
3. 部署到服务器（HTTP 模式）
4. 添加更多 MCP 工具（如有需要）
