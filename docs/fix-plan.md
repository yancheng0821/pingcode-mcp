# PingCode MCP Server - 问题检查报告与修复方案

> 日期：2026-02-15
> 基于：评审报告 (Pingcode-MCP-Result.pdf) + 源码逐项验证

---

## 一、总体结论

### 功能需求满足情况

**PRD 核心功能已基本实现**，5 个 MCP 工具（list_users、list_workloads、get_work_item、user_work_summary、team_work_summary）均可运行，时间分片、缓存、指标统计等基础能力到位。

| PRD 需求项 | 状态 | 说明 |
|-----------|------|------|
| T1 list_users | ✅ 已实现 | 本地切片分页，非服务端分页（可接受） |
| T2 list_workloads | ⚠️ 部分 | 功能正常，但 schema 漂移（filter_project_id 未暴露） |
| T3 get_work_item | ✅ 已实现 | 含批量缓存 |
| T4 user_work_summary | ⚠️ 部分 | group_by=type 实际支持但 schema 未声明 |
| T5 team_work_summary | ⚠️ 部分 | 0 工时用户被排除、missing_work_item_count 始终为 0 |
| AC1 团队时间段查询 | ⚠️ 偏差 | 0 工时用户不在"全员列表"中 |
| AC2 超 3 月分片 | ✅ 已实现 | 自动分片 + seenIds 去重 |
| AC3 鉴权配置 | ✅ 已实现 | Bearer token + HTTP 模式强制 API Key |
| 可观测性 | ✅ 已实现 | metrics 模块 + get_metrics 工具 + /metrics 端点 |
| 可靠性（重试/限流） | ⚠️ 部分 | 重试/限流有，但无超时/取消 |

### 部署上线与可维护性

**结论：功能需求大部分满足，但未达到"可上线/可维护"标准。** 存在 3 个 P0 级、5 个 P1 级问题需要修复后才能上线。

---

## 二、问题逐项验证结果

### P0 级问题（上线阻断）

#### P0-1：MCP 工具业务错误未返回 isError: true

- **状态：确认存在**
- **文件**：`src/index.ts:86-104`
- **证据**：CallTool handler 中，工具返回 `{error, code}` 形式的业务错误（如 NO_DATA、USER_NOT_FOUND、AMBIGUOUS_USER）时，直接包装为 `content[0].text = JSON.stringify(result)` 返回，不标记 `isError: true`。仅在 `throw`（catch 块 L105-122）和 unknown tool（L72-83）时才设置 `isError: true`。
- **影响**：MCP Host/LLM 会将业务错误当成功结果处理，无法自我纠错重试。

#### P0-2：HTTP 传输安全不合规

- **状态：确认存在**
- **文件**：`src/server/http.ts`
- **证据**：
  - L68: `Access-Control-Allow-Origin: '*'` — 允许任意来源
  - L161: `httpServer.listen(port, '0.0.0.0')` — 监听所有网卡
  - 全文无 Origin 校验逻辑 — 无 DNS rebinding 防护
  - L70: CORS Allow-Headers 缺少 `X-API-Key` 和 `MCP-Protocol-Version`
  - 无 DELETE 方法处理 — 会落入 404 而非 405
- **影响**：浏览器/恶意站点可通过 DNS rebinding 访问内网 MCP 服务，数据外泄风险。

#### P0-3：无请求超时/取消机制

- **状态：确认存在**
- **文件**：`src/api/client.ts:91`
- **证据**：`fetch()` 调用无 AbortController，无 timeout 参数。RateLimiter.acquire() 递归 sleep 也无中断机制。
- **影响**：网络抖动/服务端无响应时 Host 会无限挂起，线上事故级别。

### P1 级问题（上线高风险）

#### P1-1：工具 Schema 双源漂移（Zod vs JSON Schema）

- **状态：确认存在**
- **证据**：

| 工具 | Zod Schema | JSON Schema (toolDefinition) | 漂移 |
|------|-----------|------------------------------|------|
| user_work_summary | group_by enum 含 `type` (L20) | enum 不含 `type` (L261) | ✅ 缺 `type` |
| team_work_summary | group_by enum 含 `type` (L15) | enum 不含 `type` (L363) | ✅ 缺 `type` |
| list_workloads | 含 `filter_project_id` (L36) | 未声明 `filter_project_id` | ✅ 缺字段 |

- **影响**：LLM 按 JSON Schema 生成参数，无法使用 `group_by=type` 和 `filter_project_id`，实际能力被隐藏。

#### P1-2：团队汇总"全员列表"不完整

- **状态：确认存在**
- **文件**：`src/services/workloadService.ts:290`
- **证据**：`if (aggregated.totalHours > 0)` 条件过滤了 0 工时用户。
- **影响**：管理者无法看到"谁没填工时"，与 PRD AC1 "不指定 user_ids → 全员列表、每人 total_hours"有偏差。

#### P1-3：data_quality.missing_work_item_count 始终为 0

- **状态：确认存在**
- **文件**：`src/services/workloadService.ts:267,280,396`
- **证据**：L267 `const { workItems } = await ...` 未解构 `missingCount`；L280 `totalMissingWorkItemCount = 0` 初始化后从未累加；L396 直接输出为 0。
- **影响**：数据质量指标不可信，无法判断工作项信息缺失程度。

#### P1-4：HTTP Session Map 无 TTL/上限

- **状态：确认存在**
- **文件**：`src/server/http.ts:61`
- **证据**：`transports = new Map<string, StreamableHTTPServerTransport>()` 无 TTL、无最大数量限制。仅在 `transport.onclose` 时清理。
- **影响**：长期运行内存泄漏风险。

#### P1-5：周计算非 ISO 8601 标准

- **状态：确认存在**
- **文件**：`src/services/workloadService.ts:657-667`
- **证据**：`getWeekKey()` 使用手工算法 `Math.ceil((days + jan1.getDay() + 1) / 7)`，不符合 ISO 8601 周数定义（week 1 = 包含该年第一个周四的那周）。
- **影响**：跨年周报表口径错误。

#### P1-6：group_by=type 输出未暴露（仅 schema 与聚合支持）

- **状态：确认存在**
- **文件**：
  - `src/tools/userWorkSummary.ts`
  - `src/tools/teamWorkSummary.ts`
- **证据**：
  - `user_work_summary` 的 formatOutput 未输出 `summary.by_type`。
  - `team_work_summary` 的 formatOutput 未输出成员 `by_type` 和团队 `summary.by_type`。
- **影响**：即使传入 `group_by=type`，调用方也无法看到类型聚合结果。

### P2 级问题（建议修复）

| # | 问题 | 文件 | 验证结果 |
|---|------|------|---------|
| P2-1 | CORS Allow-Headers 缺少 X-API-Key、MCP-Protocol-Version | `http.ts:70` | ✅ 确认 |
| P2-2 | parseRequestBody 吞掉非法 JSON（resolve(undefined)） | `http.ts:211-212` | ✅ 确认 |
| P2-3 | TOKEN_MODE 配置存在但未参与任何逻辑 | `config/index.ts:9` | ✅ 确认 |
| P2-4 | console.log 在 HTTP 模式输出到 stdout（应走 logger） | `http.ts:163` | ✅ 确认 |
| P2-5 | 429 未读取 Retry-After 头，仅本地限流 | `client.ts:103-117` | ✅ 确认 |
| P2-6 | listWorkloadsForUsers 拉全量再本地分发，大组织风险 | `workloads.ts:212-234` | ✅ 确认 |
| P2-7 | list_users 未限制 page_index >= 1 | `listUsers.ts:17-25` | ✅ 确认 |
| P2-8 | 用户列表缓存（TTL 1h）在设计文档中声明，但未实现 | `api/endpoints/users.ts` | ✅ 确认 |

---

## 三、修复方案

### Step 1：修复 MCP 错误语义（P0-1）

**目标**：工具返回业务错误时正确标记 `isError: true`，让 LLM 可自我纠错。

**修改文件**：`src/index.ts`

**具体修改**：

在 CallTool handler 中添加业务错误检测函数：

```typescript
// 检测是否为业务错误（包含 error + code 字段的对象）
function isBusinessError(result: unknown): boolean {
  return (
    !!result &&
    typeof result === 'object' &&
    'error' in result &&
    'code' in result &&
    typeof (result as Record<string, unknown>).error === 'string' &&
    typeof (result as Record<string, unknown>).code === 'string'
  );
}
```

修改 L86-104 的工具结果返回逻辑：

```typescript
// 调用版本化工具
const { result, warnings } = await toolRegistry.callTool(name, args);

metrics.recordSuccess(`tool:${name}`, Date.now() - startTime);

const response: { result: unknown; warnings?: string[] } = { result };
if (warnings.length > 0) {
  response.warnings = warnings;
}

const payload = response.warnings ? response : result;
const text = JSON.stringify(payload, null, 2);

// 业务错误（NO_DATA / USER_NOT_FOUND 等）标记 isError
if (isBusinessError(result)) {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

return {
  content: [{ type: 'text', text }],
};
```

同样处理 builtin 工具的返回（L59-69）。

---

### Step 2：消除 Schema 双源漂移（P1-1）

**目标**：Zod Schema 与 JSON Schema (toolDefinition) 保持一致。

**修改文件**：
- `src/tools/userWorkSummary.ts`
- `src/tools/teamWorkSummary.ts`
- `src/tools/listWorkloads.ts`

**具体修改**：

**(a) userWorkSummary.ts — 补齐 group_by enum**

L261 的 `enum` 从：
```json
["day", "week", "month", "work_item", "project"]
```
改为：
```json
["day", "week", "month", "work_item", "project", "type"]
```

**(b) teamWorkSummary.ts — 补齐 group_by enum**

L363 的 `enum` 从：
```json
["user", "project", "work_item", "day", "week", "month"]
```
改为：
```json
["user", "project", "work_item", "day", "week", "month", "type"]
```

**(c) listWorkloads.ts — 补齐 filter_project_id**

在 toolDefinition 的 `inputSchema.properties` 中添加：
```json
"filter_project_id": {
    "type": "string",
    "description": "按项目 ID 过滤（本地过滤，可与其他过滤条件组合）"
}
```

---

### Step 3：HTTP 传输安全加固（P0-2）

**目标**：防止 DNS rebinding 攻击，收紧 CORS。

**修改文件**：`src/server/http.ts`、`src/config/index.ts`

**具体修改**：

**(a) 新增配置项**

`src/config/index.ts` 的 auth 对象中添加：
```typescript
allowedOrigins: z.string().default(''),  // 逗号分隔的允许 Origin 列表
httpHost: z.string().default('127.0.0.1'),  // 默认仅本地
```

**(b) 添加 Origin 校验**

在 `src/server/http.ts` 的 createServer 回调开头添加 Origin 校验：

```typescript
// Origin 校验（防 DNS rebinding）
const origin = req.headers['origin'] as string | undefined;
const allowedOrigins = config.auth.allowedOrigins
  ? new Set(config.auth.allowedOrigins.split(',').map(s => s.trim()).filter(Boolean))
  : new Set<string>();

if (origin && allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Forbidden', message: 'Invalid Origin' }));
  return;
}
```

**(c) 收紧 CORS**

将 `Access-Control-Allow-Origin: *` 改为根据 allowlist 回显 Origin 或不发送 CORS 头：

```typescript
if (origin && allowedOrigins.has(origin)) {
  res.setHeader('Access-Control-Allow-Origin', origin);
} else if (allowedOrigins.size === 0) {
  // 未配置时保持开放（向后兼容），但推荐配置
  res.setHeader('Access-Control-Allow-Origin', '*');
}
```

**(d) 补全 CORS Allow-Headers**

```typescript
res.setHeader('Access-Control-Allow-Headers',
  'Content-Type, Authorization, Mcp-Session-Id, X-API-Key, MCP-Protocol-Version');
```

**(e) 默认绑定 127.0.0.1**

```typescript
const host = config.auth.httpHost || '127.0.0.1';
httpServer.listen(port, host, () => { ... });
```

**(f) 处理 DELETE 方法**

在 MCP 端点路由中添加：
```typescript
if (path === '/mcp' && req.method === 'DELETE') {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    transports.get(sessionId)!.close();
    transports.delete(sessionId);
    res.writeHead(200);
    res.end();
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
  }
  return;
}
```

---

### Step 4：API Client 增加超时/取消机制（P0-3）

**目标**：避免无限挂起。

**修改文件**：`src/api/client.ts`、`src/config/index.ts`

**具体修改**：

**(a) 新增配置项**

```typescript
// 在 config 中添加
requestTimeout: z.number().default(15000),  // 15s 单次请求超时
```

**(b) fetch 增加 AbortController**

在 `PingCodeApiClient.request()` 方法中：

```typescript
async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', params, body } = options;

  // ... URL 构建 & 限流 ...

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.requestTimeout || 15000
    );

    try {
      const response = await fetch(url.toString(), {
        method,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      // ... 原有逻辑 ...
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        lastError = new Error(`Request timeout after ${config.requestTimeout}ms: ${endpoint}`);
      } else if (error instanceof PingCodeApiError) {
        throw error;
      } else {
        lastError = error as Error;
      }
      // ... 重试逻辑 ...
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('Request failed after retries');
}
```

**(c) 429 尊重 Retry-After（P2-5 一并修复）**

在 HTTP 错误处理中添加：

```typescript
if (response.status === 429) {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const waitMs = parseInt(retryAfter, 10) * 1000 || RETRY_CONFIG.baseDelay;
    await this.sleep(Math.min(waitMs, RETRY_CONFIG.maxDelay));
    continue;
  }
}
```

---

### Step 5：修复团队汇总口径（P1-2 + P1-3）

**目标**：全员列表包含 0 工时用户；修复 missing_work_item_count。

**修改文件**：`src/services/workloadService.ts`

**(a) 包含 0 工时用户**

将 L290 的条件判断：
```typescript
if (aggregated.totalHours > 0) {
```
改为始终 push，同时保留排序逻辑（0 工时用户排在最后）。

**(b) 修复 missing_work_item_count**

L267 改为解构 missingCount：
```typescript
const { workItems, missingCount } = await workItemService.enrichWorkloadsWithWorkItems(allWorkloads);
```

注意：若存在 `project_id` 过滤，应基于过滤后的 workloads 重新计算 missingCount，避免把其它项目的缺失也算进去。

示例修复策略（两种二选一）：
1) 在过滤后重新调用 `enrichWorkloadsWithWorkItems(allFilteredWorkloads)` 并取 `missingCount`。
2) 若只在未过滤时计算，可在过滤前后分别统计并根据条件选用。

---

### Step 6：修复 ISO 周计算（P1-5）

**修改文件**：`src/services/workloadService.ts`

将 `getWeekKey()` 方法替换为标准 ISO 8601 周计算：

```typescript
private getWeekKey(timestamp: number): string {
  const date = new Date(timestamp * 1000);

  // ISO 8601 周数计算
  const target = new Date(date.valueOf());
  target.setDate(target.getDate() - ((target.getDay() + 6) % 7) + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  }
  const weekNum = 1 + Math.ceil((firstThursday - target.valueOf()) / (7 * 24 * 60 * 60 * 1000));
  const year = new Date(firstThursday).getFullYear();

  return `${year}-W${weekNum.toString().padStart(2, '0')}`;
}
```

---

### Step 7：HTTP Session 治理（P1-4）+ 其他 P2 问题

**修改文件**：`src/server/http.ts`

**(a) Session Map 添加 TTL 和上限**

```typescript
const MAX_SESSIONS = 100;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 分钟

// 定期清理过期 session
const sessionTimestamps = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of sessionTimestamps) {
    if (now - ts > SESSION_TTL_MS) {
      const transport = transports.get(id);
      if (transport) transport.close();
      transports.delete(id);
      sessionTimestamps.delete(id);
    }
  }
}, 60_000); // 每分钟检查一次
```

创建新 session 时检查上限并更新时间戳（并在每次请求时更新 lastActive，避免活跃 session 被回收）：

```typescript
if (transports.size >= MAX_SESSIONS) {
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Too many sessions' }));
  return;
}

// 在存储 transport 后：
sessionTimestamps.set(transport.sessionId!, Date.now());

// 每次请求时续期（在复用 transport 的分支中也应更新）
sessionTimestamps.set(sessionId, Date.now());
```

**(b) parseRequestBody 返回 400（P2-2）**

```typescript
// 将 catch { resolve(undefined); } 改为：
catch (e) {
  reject(new SyntaxError('Invalid JSON in request body'));
}
```

在调用处 catch 并返回 400：

```typescript
let body: unknown;
try {
  body = await parseRequestBody(req);
} catch {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Bad Request', message: 'Invalid JSON' }));
  return;
}
```

**(c) console.log 改为 logger（P2-4）**

```typescript
// L163: console.log(...) 改为:
logger.info({ port, host }, 'MCP HTTP Server running');
```

---

### Step 8：补齐 group_by=type 输出（P1-6）

**修改文件**：
- `src/tools/userWorkSummary.ts`
- `src/tools/teamWorkSummary.ts`

**具体修改**：

**(a) userWorkSummary.ts — 输出 by_type**

在 `formatOutput()` 中补充：
```typescript
by_type: result.summary.by_type,
```

**(b) teamWorkSummary.ts — 输出成员与团队 by_type**

在成员映射中添加：
```typescript
if (m.by_type) {
  member.by_type = m.by_type;
}
```

在 summary 聚合中添加：
```typescript
if (result.summary.by_type) {
  output.summary.by_type = result.summary.by_type;
}
```

---

### Step 9：用户列表缓存与分页参数校验（P2-7/P2-8）

**修改文件**：
- `src/api/endpoints/users.ts`
- `src/services/userService.ts`
- `src/cache/memory.ts`
- `src/tools/listUsers.ts`

**具体修改**：

**(a) 为 list_users 添加 page_index 最小值约束**
```typescript
page_index: z.number().min(1).optional().default(1),
```

**(b) 为用户列表增加缓存（与设计文档一致）**
建议：在 `listUsers()` 中先读缓存 `CacheKeys.usersList()`，TTL 使用 `config.cache.ttlUsers`，并在命中时返回缓存结果；未命中则拉取并写入缓存。

---

## 四、修复优先级与依赖关系

```
Step 1 (P0-1)  ──┐
Step 3 (P0-2)  ──┤── 无依赖，可并行
Step 4 (P0-3)  ──┘

Step 2 (P1-1)  ──┐
Step 5 (P1-2/3)──┤── 无依赖，可并行
Step 6 (P1-5)  ──┘

Step 8 (P1-6)  ──┐
Step 7 (P1-4 + P2) ──┤── 次要，最后处理
Step 9 (P2-7/8) ──┘
```

**建议执行顺序**：

| 顺序 | Step | 优先级 | 涉及文件 |
|------|------|--------|---------|
| 1 | Step 1 | P0 | index.ts |
| 2 | Step 3 | P0 | http.ts, config/index.ts |
| 3 | Step 4 | P0 | client.ts, config/index.ts |
| 4 | Step 2 | P1 | userWorkSummary.ts, teamWorkSummary.ts, listWorkloads.ts |
| 5 | Step 5 | P1 | workloadService.ts |
| 6 | Step 6 | P1 | workloadService.ts |
| 7 | Step 8 | P1 | userWorkSummary.ts, teamWorkSummary.ts |
| 8 | Step 7 | P1/P2 | http.ts |
| 9 | Step 9 | P2 | users.ts, userService.ts, listUsers.ts, cache/memory.ts |

---

## 五、验证清单

修复完成后需验证：

- [ ] 工具返回 NO_DATA 时，CallToolResult.isError === true
- [ ] 工具返回 USER_NOT_FOUND 时，CallToolResult.isError === true
- [ ] 工具返回正常数据时，CallToolResult.isError 不存在或为 false
- [ ] HTTP 模式带非法 Origin 请求被 403 拒绝
- [ ] 默认绑定 127.0.0.1 而非 0.0.0.0
- [ ] DELETE /mcp 正确终止 session
- [ ] fetch 超时后抛出可解释错误（非无限挂起）
- [ ] user_work_summary group_by=type 在 listTools schema 中可见
- [ ] team_work_summary group_by=type 在 listTools schema 中可见
- [ ] list_workloads filter_project_id 在 listTools schema 中可见
- [ ] 团队汇总包含 0 工时用户（total_hours=0）
- [ ] data_quality.missing_work_item_count 反映真实缺失数
- [ ] 周聚合跨年边界正确（ISO 8601）
- [ ] group_by=type 时返回 by_type 字段（用户与团队）
- [ ] HTTP session 超过 TTL 自动清理
- [ ] typecheck 通过（`npm run typecheck`）
- [ ] 回归测试通过（`npm test`）
