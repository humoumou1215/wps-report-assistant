# Conversation + Reversible Render 实现说明

本仓库当前主链路是：

```text
Conversation → Task → Sandbox Candidate → Render Gateway
→ PREPARED Ledger → Before Snapshot → WPS Adapter Apply
→ After Snapshot → Program Verification → Agent Verification
```

## 已落地的安全边界

- `Variable` 是 Project 级事实，支持 `inputs[]`、解释版本和 lineage；变量的创建和修改以 Conversation Agent 为主入口。
- 会话、消息和任务独立存储。引用在发送时校验项目归属，选区引用必须先冻结；引用不会把完整值注入 Agent 上下文。
- Task Operation 支持依赖图、循环检测和可运行节点计算。
- `RenderGateway` 是真实 Render 的唯一程序入口：捕获 Before、生成快照恢复 Inverse、写入 PREPARED、Apply、重新捕获 After、执行程序验证。HTTP API 不接受绕过 Agent 的 Render 写入请求。
- `RenderLedger` 使用项目级 append-only JSONL、内容寻址 Snapshot 和 hash chain。幂等键为 `taskOperationId`；Undo、Recovery 都是新记录。
- `auto-reversible`/`agent-auto` 会拒绝不可逆能力；目标指纹、变量版本和绑定版本冲突会阻止旧计划执行。
- `review` 模式把完整 Render 方案与变更摘要保存为待确认 Task Operation；确认时重新校验方案指纹、数据版本和目标，再走同一个 Gateway。
- 启动/恢复可扫描 `prepared`、`applying` 记录，区分未 Apply、已完成或需要人工恢复的状态。
- Add-in 主界面收敛为会话、变量、设置三页；支持会话切换、重命名、压缩和归档，变量自然语言修改回到会话执行。

## API 入口

```text
GET/POST /api/projects/:pid/conversations
GET/PATCH /api/projects/:pid/conversations/:cid
POST /api/projects/:pid/conversations/:cid/messages
POST /api/projects/:pid/conversations/:cid/compact
GET /api/projects/:pid/references?q=...
GET /api/projects/:pid/documents/:did[/index|/search]
GET /api/projects/:pid/variables[/:vid][/lineage|/render-history]
GET/POST /api/projects/:pid/variables/:vid/revisions
GET /api/projects/:pid/render-records
GET /api/projects/:pid/render-records/:rid
POST /api/projects/:pid/render-records/:rid/undo
POST /api/projects/:pid/render-records/:rid/recover
```

现有 WPS Add-in 通过本地 WPS Bridge 提交真实宿主快照；服务端同时写入 Render Ledger，作为没有 Node 侧 WPS COM/JSAPI 的桥接适配器。自动测试覆盖虚拟宿主的完整流程；真实 WPS 的 Adapter 能力、视觉排版和宿主版本差异仍需用户按验收指南回归。
