**“PingCode 开放接口 + MCP（Model Context Protocol）”** 的 PRD（需求文档）。目标是：**你可以按任意时间段查询“每个人在做什么（关联到哪些工作项/事项）以及工时是多少”**，并让大模型用自然语言就能拿到结构化结果、自动汇总报表。

> 关键外部约束（来自官方接口文档/说明）：
>
> - 工时查询入口：`GET /v1/workloads`（支持按成员/项目/工作项维度查询）。 ([pingcode.apifox.cn](https://pingcode.apifox.cn/api-136244254))
> - 企业成员列表：`GET /v1/directory/users`。 ([pingcode.apifox.cn](https://pingcode.apifox.cn/api-101825988))
> - 工作项详情：`GET /v1/project/work_items/{project_work_item_id}`。 ([pingcode.apifox.cn](https://pingcode.apifox.cn/api-115141899?utm_source=chatgpt.com))
> - 时间字段为 **10 位时间戳**（秒）。 ([pingcode.apifox.cn](https://pingcode.apifox.cn/?utm_source=chatgpt.com))
> - 工时查询时间跨度 **不超过 3 个月**（性能限制，需要分片聚合）。 ([PingCode Blog](https://blog.pingcode.com/v5-65-0-release/?utm_source=chatgpt.com))
> - 鉴权采用 `Authorization: Bearer <token>`，支持企业令牌（Client Credentials）或用户令牌（Authorization Code）。 ([pingcode.apifox.cn](https://pingcode.apifox.cn/folder-20092472))

------

## 1. 背景与问题

团队在 PingCode 上记录了工作项与工时，但管理者/负责人常见诉求是：

- “上周每个人做了什么？分别投入多少工时？主要投在哪些项目/工作项？”
- “本月某人都在忙哪些事情？每天投入如何？”
- “某个时间段内，团队工时分布（按人/按项目/按工作项/按工时类型）”

传统做法需要手工导出/筛选，口径不统一，时间成本高。希望通过 MCP 把 PingCode 数据变成 **大模型可直接调用的工具**，用自然语言一键得到 **可追溯、可汇总** 的结果。

------

## 2. 目标（Goals）& 非目标（Non-goals）

### 2.1 目标

1. 支持按时间段查询：**每个人做了什么（关联工作项/事项）+ 工时总量**。
2. 支持多种汇总维度：按人、按天/周/月、按项目、按工作项、按工时类型。
3. 输出同时包含：
   - **明细**（可追溯到 workload / work_item）
   - **汇总**（总工时、Top N 工作项/项目、分布）
4. 面向大模型：提供 **稳定、少而精** 的 MCP Tools，便于自然语言调用与组合。

### 2.2 非目标（本期不做）

- 不做 PingCode 内部 UI 前端（只提供 MCP server）
- 不强依赖“创建/修改工时/工作项”（本期以读为主；写能力可作为二期）
- 不做复杂权限编排（先沿用 PingCode token 权限）

------

## 3. 角色与使用场景

### 3.1 角色

- 团队负责人/研发经理：看团队投入与分布
- 项目经理/Scrum Master：看迭代/项目维度投入
- 个人：回顾某段时间做了什么、工时填报是否完整

### 3.2 核心场景（必须支持）

1. **按时间段查团队**
   - “查 2026-01-01 到 2026-01-31，团队每个人做了什么、工时多少”
2. **按时间段查个人**
   - “查张三上周做了什么、每天多少工时、主要在哪些工作项”
3. **按项目/工作项维度聚合**
   - “这两周项目 A 的工时都花在哪些工作项？分别谁贡献了多少？”

------

## 4. 需求范围与数据口径

### 4.1 数据来源（PingCode Open API）

- 企业成员：`GET /v1/directory/users` ([pingcode.apifox.cn](https://pingcode.apifox.cn/api-101825988))
- 工时记录：`GET /v1/workloads`（带 `principal_type/principal_id/start_at/end_at/...`） ([pingcode.apifox.cn](https://pingcode.apifox.cn/api-136244254))
- 工作项详情：`GET /v1/project/work_items/{id}`（用于把“做了什么”落到具体工作项标题/编号/项目） ([pingcode.apifox.cn](https://pingcode.apifox.cn/api-115141899?utm_source=chatgpt.com))

### 4.2 时间口径

- 入参允许：自然语言（“上周”“本月”）或显式日期
- MCP 内部统一转换为 **10 位时间戳（秒）**。 ([pingcode.apifox.cn](https://pingcode.apifox.cn/?utm_source=chatgpt.com))
- 若查询跨度 > 3 个月：必须 **自动分片（<=3个月/片）** 调用 `workloads` 再合并。 ([PingCode Blog](https://blog.pingcode.com/v5-65-0-release/?utm_source=chatgpt.com))

### 4.3 “在做什么”的定义（默认口径）

- 以 **工时记录关联的事项** 为准：一个人“做了什么”= 该时间段内他有工时投入的工作项/事项（work_item/项目/其他 principal）。
- 可选增强：补充“被分配但未填工时的工作项”（二期或开关能力，避免口径争议）。

------

## 5. 功能需求（MCP Tools 设计）

> 原则：工具数量少、返回结构稳定、能组合。
> 下面工具命名仅建议，可按你现有 MCP 框架风格调整。

### 5.1 基础工具

#### T1. `pingcode.list_users`

- **目的**：获取企业成员列表（用于“每个人”以及按姓名模糊匹配）
- **对接接口**：`GET /v1/directory/users` ([pingcode.apifox.cn](https://pingcode.apifox.cn/api-101825988))
- **入参**：
  - `keyword?`（可选，客户端侧过滤 display_name/name/email）
  - `page_size?`, `page_index?`
- **返回**：`[{id, name, display_name, department?, job?, email?}]`

#### T2. `pingcode.list_workloads`

- **目的**：获取工时明细（可按成员/项目/工作项）
- **对接接口**：`GET /v1/workloads` ([pingcode.apifox.cn](https://pingcode.apifox.cn/api-136244254))
- **入参（建议最小集）**：
  - `principal_type`：`user|project|work_item`（按文档示例字段） ([pingcode.apifox.cn](https://pingcode.apifox.cn/api-136244254))
  - `principal_id`
  - `start_at`（timestamp 秒）
  - `end_at`（timestamp 秒）
  - `report_by_id?`（可选：按填报人过滤，字段来自文档示例） ([pingcode.apifox.cn](https://pingcode.apifox.cn/api-136244254))
- **约束**：若 `end_at - start_at` > 3 个月 => MCP 自动分片 ([PingCode Blog](https://blog.pingcode.com/v5-65-0-release/?utm_source=chatgpt.com))
- **返回**：工时数组（保持 PingCode 原始字段 + 关键标准化字段）
  - 标准化字段建议：`{id, user_id, work_item_id?, project_id?, hours, date_at, type_id?, description? ...}`
  - 若接口返回字段不全，则允许 MCP 在服务端做“字段适配层”（Mapping Layer）

#### T3. `pingcode.get_work_item`

- **目的**：把 work_item_id 解析成“在做什么”的可读信息（编号/标题/项目）
- **对接接口**：`GET /v1/project/work_items/{project_work_item_id}` ([pingcode.apifox.cn](https://pingcode.apifox.cn/api-115141899?utm_source=chatgpt.com))
- **返回**：`{id, identifier, title, project:{id, identifier, name, type}, assignee?, state?, ...}`

------

### 5.2 报表级工具（核心）

#### T4. `pingcode.user_work_summary`

- **一句话**：输入“人 + 时间段”，输出“做了什么 + 工时多少（明细+汇总）”
- **入参**：
  - `user`：`{id}` 或 `{name}`（若 name：先 list_users 匹配）
  - `time_range`：`{start, end}`（支持自然语言如 “last_week” 也可）
  - `group_by?`：`day|week|month|work_item|project`（默认 `work_item`）
  - `top_n?`：默认 10
- **内部流程**：
  1. 调 `list_workloads(principal_type=user, principal_id=user_id, start_at, end_at)`
  2. 抽取涉及的 `work_item_id` 批量拉 `get_work_item`（做缓存）
  3. 聚合：总工时、按 group_by 分组、TopN
- **输出结构（建议）**：
  - `summary`: `{user, start_at, end_at, total_hours, by_project[], by_work_item[], by_day[]}`
  - `details`: `[{date_at, hours, work_item:{identifier,title,project}, description?}]`
  - `data_quality`: `{workloads_count, missing_work_item_count, time_sliced:boolean}`

#### T5. `pingcode.team_work_summary`

- **一句话**：输入“时间段（可选：项目）”，输出“每个人做了什么 + 工时多少”
- **入参**：
  - `time_range`
  - `user_ids?`（不传则默认“全员”= list_users）
  - `project_id?`（可选：只看某项目投入）
  - `group_by?`：默认 `user`，并提供二级分组 `project/work_item`
- **输出结构**：
  - `summary`: `[{user, total_hours, top_projects[], top_work_items[]}]`
  - `matrix`（可选）：`by_day` 或 `by_week` 的人天矩阵
  - `details_linking`：可追溯到 workload_id 列表（用于审计/追问）

------

## 6. 鉴权与配置需求

### 6.1 Token 类型

- **企业令牌（Client Credentials）**：不区分用户身份，偏管理员权限，需谨慎保管。 ([pingcode.apifox.cn](https://pingcode.apifox.cn/folder-20092472))
- **用户令牌（Authorization Code）**：归属某个用户，只能访问该用户有权限的数据。 ([pingcode.apifox.cn](https://pingcode.apifox.cn/folder-20092473))

### 6.2 MCP Server 配置项（建议）

- `PINGCODE_BASE_URL`：公有云默认 `https://open.pingcode.com` ([pingcode.apifox.cn](https://pingcode.apifox.cn/?utm_source=chatgpt.com))
- `PINGCODE_TOKEN`：Bearer token（推荐仅在服务端保存）
- `TOKEN_MODE`：`enterprise|user`
- `CACHE_TTL_USERS`（如 1h），`CACHE_TTL_WORK_ITEMS`（如 6h）
- `RATE_LIMIT_PER_MIN`（默认不超过官方限制；文档提示每分钟上限 200 次） ([pingcode.apifox.cn](https://pingcode.apifox.cn/))

------

## 7. 非功能需求（NFR）

1. **性能**
   - 具备缓存与批量拉取工作项详情能力（避免 N+1）
   - 时间跨度超 3 个月自动分片聚合（透明对用户） ([PingCode Blog](https://blog.pingcode.com/v5-65-0-release/?utm_source=chatgpt.com))
2. **可靠性**
   - 网络错误重试（指数退避），但避免放大请求
3. **安全**
   - Token 不落日志；敏感字段脱敏
   - 建议只在内网部署或加反向代理鉴权
4. **可观测性**
   - 请求量、失败率、分片次数、平均耗时、缓存命中率
5. **兼容性**
   - MCP 协议标准实现；工具 schema 稳定可版本化（v1/v2）

------

## 8. 交互示例（你将如何“问”它）

- “帮我查 **2026-01-01 到 2026-01-31**，每个人做了什么，工时分别多少，并列出每人 Top 5 工作项。”
  - → 调 `team_work_summary(time_range=...)`
- “张三上周做了什么？按天汇总，每天多少工时；再列出投入最多的 3 个工作项。”
  - → 调 `user_work_summary(user=name=张三, group_by=day, top_n=3)`
- “项目 KB（或 project_id=xxx）这两周的工时分布，按人排序。”
  - → 调 `team_work_summary(project_id=..., group_by=user)`

------

## 9. 验收标准（Acceptance Criteria）

### AC1：团队时间段查询

- 输入：`start/end`（<=3个月）、不指定 user_ids
- 输出：包含全员列表、每人 total_hours、每人 Top work items/projects
- 明细可追溯到 workload_id；当存在 work_item_id 时能解析到标题/编号（identifier/title）。 ([pingcode.apifox.cn](https://pingcode.apifox.cn/api-115141899?utm_source=chatgpt.com))

### AC2：跨度超 3 个月

- 输入：`start/end` 超 3 个月
- 系统自动分片调用，输出合并后的 totals，并在 `data_quality.time_sliced=true` 标记。 ([PingCode Blog](https://blog.pingcode.com/v5-65-0-release/?utm_source=chatgpt.com))

### AC3：权限与鉴权

- 未提供 token：返回标准错误（401/配置错误）
- 使用 Bearer token 调用 PingCode API，符合文档要求。 ([pingcode.apifox.cn](https://pingcode.apifox.cn/folder-20092472))

------

## 10. 实施建议（技术方案简述）

- **服务形态**：MCP Server（Go/TS/** 均可），内部封装 PingCode REST client
- **推荐先读后写**：只实现 list_users / list_workloads / get_work_item + 两个 summary 工具
- **可复用开源**：已有 PingCode MCP 服务器项目提供了“工作项/工时/用户”等工具集合与示例（可用于对齐工具边界与工程结构）。 ([GitHub](https://github.com/peach-zhang/PingCodeMcp))

------

