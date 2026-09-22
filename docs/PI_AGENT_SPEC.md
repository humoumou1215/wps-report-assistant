# WPS Report Assistant

# Pi + TypeScript Agent Runtime Architecture SPEC

## 0. 文档定位

本文定义 WPS Report Assistant 下一代核心架构。

目标是将当前：

WPS Addin → Go Core → 单轮 AI 调用 → JS 执行 → Preview

重构为：

WPS Addin → TypeScript Agent Host → Pi Agent Runtime → Domain Tools → Sandbox → Preview

核心设计原则：

**一个 Variable 对应一个长期 AI Session。**

AI 应能够记住：

* 用户最初为什么创建这个 Variable；
* 用户后续如何修改过业务要求；
* 用户曾经纠正过哪些理解错误；
* Agent 在该变量处理过程中遇到过哪些问题；
* 哪些业务语义已经被用户确认。

但：

**Session 和 memory.md 都不是业务事实数据库。**

Source、Variable、Binding、Document、Revision 等实时状态，始终以 Project Store 为唯一真相。

---

# 1. 最终目标架构

```text
┌──────────────────────────────────────────────────────┐
│                     WPS ET                           │
│                                                      │
│  Selection / Source UI / Variable UI                 │
└───────────────────────┬──────────────────────────────┘
                        │
                        │ localhost HTTP / SSE
                        │
┌───────────────────────▼──────────────────────────────┐
│                                                      │
│            DataReportAssistant Agent Host            │
│                   TypeScript / Node                  │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │                Application Core                │  │
│  │                                                │  │
│  │ Project Store                                  │  │
│  │ Source / Variable / Binding                    │  │
│  │ Draft / Revision / Change History              │  │
│  │ API Server                                     │  │
│  └───────────────────┬────────────────────────────┘  │
│                      │                               │
│  ┌───────────────────▼────────────────────────────┐  │
│  │             Variable Agent Runtime             │  │
│  │                                                │  │
│  │ Pi Agent Session                               │  │
│  │ memory.md                                      │  │
│  │ Context Builder                                │  │
│  │ Domain Tools                                   │  │
│  │ Compaction                                     │  │
│  │ Retry / Tool Loop                              │  │
│  └───────────────────┬────────────────────────────┘  │
│                      │                               │
│             ┌────────┴─────────┐                     │
│             ▼                  ▼                     │
│      Domain Tool Layer     Stateless Critic          │
│             │                                        │
│             ▼                                        │
│      Sandbox Worker                                 │
│      QuickJS / WASM                                 │
│                                                     │
└───────────────────────┬─────────────────────────────┘
                        │
                        │ localhost HTTP / SSE
                        │
┌───────────────────────▼─────────────────────────────┐
│                     WPS WPP                         │
│                                                     │
│ Target Snapshot / Preview / Apply / Undo            │
└─────────────────────────────────────────────────────┘
```

Node Agent Host 是：

**项目数据和 Agent 状态的唯一写入进程。**

WPS ET/WPP 不直接修改：

* Project Store；
* Session；
* memory.md；
* Variable Revision；
* Binding Revision。

WPS 只负责：

* 读取真实 WPS 内容；
* 把 Source / Target Snapshot 提交给 Agent Host；
* 展示 Preview；
* 用户确认后执行 RenderPlan；
* 把 Before / After Snapshot 返回 Agent Host。

---

# 2. 技术栈

运行时：

```text
Node.js 22.19.x
TypeScript 5.x
```

Pi 固定版本：

```text
@earendil-works/pi-coding-agent 0.86.0
```

必须使用精确版本：

```json
"@earendil-works/pi-coding-agent": "0.86.0"
```

禁止：

```json
"^0.86.0"
"latest"
```

Pi 升级必须经过 Agent Regression Suite。

初期正式安装包直接内置固定 Node Runtime。

不要求用户：

* 安装 Node；
* 安装 npm；
* 安装 Pi；
* 配置个人 `.pi`；
* 配置全局环境。

用户自己的 Pi 配置不得影响本产品。

---

# 3. Pi 的使用边界

本项目使用 Pi 作为：

```text
Agent Runtime
Session Runtime
Tool Loop
Context Compaction
Model Runtime
Event Stream
Retry Framework
```

但不把产品做成 Coding Agent。

必须禁用 Pi 内置：

```text
read
write
edit
bash
powershell
grep
find
ls
```

不得自动发现：

```text
用户 ~/.pi extensions
用户 ~/.pi skills
用户 ~/.pi AGENTS.md
项目目录 .pi/
第三方 Pi packages
```

不得让用户安装的 Pi extension 进入 WPS Report Assistant。

Agent 只能看到本产品注册的 Domain Tools。

最终 Tool Set 必须采用显式 allowlist。

---

# 4. Variable 与 Session 的一一关系

核心规则：

```text
Variable
   1
   │
   │
   1
Pi Session
```

Variable 数据结构增加：

```ts
interface Variable {
  id: string;

  sessionId: string;

  sourceId: string;

  transform: TransformScript;

  valueType: VariableValueType;

  columns: string[];

  value: unknown;

  revision: number;

  ...
}
```

Session ID 不使用：

```text
变量名
displayName
Source Address
```

必须使用稳定 UUID。

---

# 5. Session 创建时机

Session 不能等 Variable 保存以后才创建。

否则第一次 Agent 调试过程会丢失。

正确生命周期：

```text
用户读取选区
    ↓
不创建 Session

用户填写：
变量名
自然语言要求
    ↓
点击“生成变量预览”
    ↓
创建 VariableDraft
    ↓
创建 Pi Session
    ↓
Agent 开始工作
    ↓
Preview
    ↓
用户确认
    ↓
VariableDraft → Variable
    ↓
同一个 Session 绑定到 Variable
```

因此存在：

```ts
interface VariableDraft {
  id: string;
  sessionId: string;

  projectId: string;
  sourceDraft: SourceDraft;

  ...
}
```

Session Scope 初始：

```text
variable-draft:{draftId}
```

保存以后迁移为：

```text
variable:{variableId}
```

Pi Session 本身不重新创建。

---

# 6. 哪些操作创建 / 恢复 Session

## 创建新 Session

仅：

```text
用户第一次要求 AI 创建新的 Variable
```

## Resume Existing Session

以下操作全部恢复已有 Variable Session：

```text
修改变量要求

“刚才排序错了”

“再过滤正式员工”

“增加同比字段”

“把预算字段换成本年预算”

为这个 Variable 创建 Binding

修改该 Variable 的某个 Binding
```

## 不产生 AI Turn

以下操作不应该污染 Session：

```text
读取 Excel 选区

刷新 Source

重新执行已有 Transform

查看 Variable

打开结果详情

撤销文档修改

重新执行已有 Renderer
```

如果 deterministic refresh 成功：

完全不调用 Agent。

---

# 7. Source 变化导致 Transform 失败

例如：

```text
原 Source：

部门
本年预算

后来 Excel 改成：

部门
年度预算
```

已有 Transform 执行失败。

系统：

```text
Source Refresh
     ↓
执行原 Transform
     ↓
SOURCE_SCHEMA_CHANGED
     ↓
保持旧 Source / Variable 不变
     ↓
UI 提示：

“数据结构发生变化，需要 AI 调整变量规则”
```

此时用户点击：

```text
让 AI 修复
```

恢复：

```text
同一个 Variable Session
```

Agent 获得：

```text
原用户意图
memory.md
旧 Transform
旧 Schema
新 Schema
执行错误
```

生成新的 Candidate。

不得静默修改 Variable。

仍必须：

```text
Preview → 用户确认 → Commit
```

---

# 8. Variable Session 同时承担 Binding 对话

第一阶段不为每个 Binding 创建独立 Pi Session。

模型保持简单：

```text
Variable A
    │
    └── Session A
          ├── Transform 对话
          ├── Binding 1 对话
          ├── Binding 2 对话
          └── Binding 3 对话
```

但每次 Render 操作必须明确注入：

```text
bindingId
documentId
targetSnapshot
bindingRevision
```

Agent 不允许仅根据聊天历史判断：

> “当前用户说的是哪一个 PPT 表格”。

必须读取当前 Binding Context。

memory.md 中 Binding 信息必须按 ID 分区：

```markdown
## Binding Decisions

### binding_001

目标：
2026经营报告.pptx / Slide 3 / Table 2

已确认：
- 第一列序号
- 金额万元
- 保留两位小数

### binding_002

目标：
管理层汇报.pptx / Slide 8 / TextBox

已确认：
- 只展示前三名
```

如果未来证明一个 Variable 拥有大量复杂 Binding 导致上下文污染，再增加 Binding Session。

第一阶段不做。

---

# 9. memory.md 定位

每个 Variable 一个：

```text
memory.md
```

例如：

```text
data/
projects/{projectId}/
  variables/{variableId}/
    memory.md
```

memory.md 保存：

**稳定语义记忆。**

不是：

**实时状态数据库。**

---

# 10. memory.md 内容

推荐结构：

```markdown
# Variable Memory

## Objective

变量：
部门预算 Top10

用户目标：
- 统计正式员工
- 按本年预算降序
- 取前10
- 输出部门和预算

## Confirmed Decisions

- 正式员工判断字段：员工状态
- 正式员工值：正式
- 排序字段：本年预算
- 金额保持“元”
- 相同金额无需二次排序

## User Corrections

- 用户曾明确指出：
  “不是去年预算，是本年预算。”

## Transform Intent

1. 过滤员工状态 == 正式
2. 按本年预算降序
3. limit 10
4. 输出部门、本年预算

## Binding Decisions

### binding_xxx

- 第一列增加序号
- 第二列部门
- 第三列预算万元
- 保留2位小数

## Variable-specific Lessons

- Source 中“预算”存在多个相似字段，
  必须使用“本年预算”。

## Revision Anchors

variableRevision: 8
sourceRevision: 12
```

---

# 11. memory.md 不允许保存的东西

禁止把下面内容作为长期事实：

```text
当前共有 1347 行

当前预算总计 123456

项目现在只有 3 个 Variable

当前 PPT 是 Slide 5

当前 Source Address = A1:G800
```

因为这些都会变化。

可以保存：

```text
revision anchor
```

用于检测 memory 是否陈旧。

但不能把 revision anchor 当事实来源。

---

# 12. memory.md 写入规则

AI 不直接修改 memory.md。

禁止提供：

```text
write_memory_file
edit_memory
```

Tool。

Agent 只能调用：

```text
propose_memory_update
```

例如：

```json
{
  "category": "user-correction",
  "content": "排序字段必须使用本年预算",
  "scope": "variable"
}
```

这些内容进入：

```text
PendingMemoryDelta
```

只有以下情况才真正写入 memory.md：

```text
用户确认 Candidate

或

系统确认属于稳定的变量级规则
```

如果用户取消 Preview：

对应 Memory Delta 不提交。

---

# 13. 系统级经验不能写入 Variable Memory

例如这次出现的：

```text
SCRIPT_NO_RETURN
```

如果证明原因是：

```text
Renderer Contract 设计错误
```

这是系统级经验。

不得写：

```text
var_A/memory.md
```

而应该进入：

```text
Agent Contract
+
Regression Test
```

否则：

```text
Variable A 学会了
Variable B 重新犯一次
```

系统经验必须提升到产品层。

---

# 14. 每次 Agent Turn 的 Context

真正发给模型的上下文：

```text
Static System Prompt
        +
Variable memory.md
        +
Fresh Project Snapshot
        +
Fresh Variable Snapshot
        +
Fresh Binding Snapshot（如有）
        +
Pi Compaction Summary
        +
Recent Session Messages
        +
Current User Intent
```

其中：

```text
Project Snapshot
Variable Snapshot
Binding Snapshot
```

每一轮重新生成。

禁止使用上一次 Session 中的旧状态代替。

---

# 15. Agent 核心原则

System Prompt 必须包含以下硬规则：

```text
你是 Variable Agent。

你负责：
理解用户数据处理意图；
生成并验证 Transform / Renderer Candidate；
根据 Tool Error 修复 Candidate。

你不能：
直接修改 WPS；
直接保存 Variable；
直接修改 Project State；
直接修改 memory.md；
访问文件系统；
访问 Shell；
访问网络；
认为 Session 中的旧项目状态仍然有效。

涉及 Source / Variable / Binding / Target 的事实，
必须以 Domain Tool 当前返回结果为准。

memory.md 是长期语义记忆，
不是实时数据库。

只有 Tool 实际执行成功的 Candidate
才可以提交给用户 Preview。
```

---

# 16. 不再让 AI 返回最终业务结果

AI 不负责：

```text
直接算出 Top10 数据
```

AI负责：

```text
生成可执行程序
```

真正结果：

```text
完整真实数据
+
Candidate Script
+
Sandbox
```

计算得到。

必须保持：

```text
AI 负责写程序
Sandbox 负责算真实结果
```

这个原则不变。

---

# 17. Transform Script 新合同

彻底废除当前模糊的：

```text
“JavaScript 函数体”
```

新标准直接采用完整函数。

Canonical Transform：

```js
function transform(rows, columns) {
  // processing

  return {
    valueType: "table",
    columns: ["部门", "本年预算"],
    value: result
  };
}
```

Canonical Renderer：

```js
function render(variable, target) {
  return {
    kind: "table",
    header: ["序号", "部门", "预算"],
    rows: []
  };
}
```

不再要求 Agent：

```text
只写函数体
```

避免再次产生：

```text
function render(){...}
被外层函数重新包裹
→ undefined
```

的问题。

---

# 18. Script Normalizer

即使采用完整函数合同，也必须容错。

Normalizer 应识别：

```text
function transform(...)
function render(...)

箭头函数

纯函数体
```

能安全转换则自动规范化。

不能规范化则返回：

```text
SCRIPT_CONTRACT_ERROR
```

不要返回：

```text
结果包含不能保存的值
```

这种无法指导 AI 修复的错误。

---

# 19. Sandbox

绝对禁止：

```text
eval()
new Function()
Node vm
```

作为安全隔离边界。

AI Script 必须运行于真正隔离环境。

推荐：

```text
QuickJS WASM
```

运行于：

```text
sandbox-worker
```

临时 Worker Process。

结构：

```text
Agent Host
    │
    │ JSON stdin / IPC
    ▼
sandbox-worker
    │
    ▼
QuickJS WASM
```

Sandbox 只能得到：

```text
rows
columns
variable
target
```

不得得到：

```text
process
require
fs
fetch
Buffer
Node API
API Key
Project filesystem path
WPS API
```

---

# 20. Sandbox 限制

保留当前安全思想：

```text
执行时间：
默认 1.5 秒

Host 硬超时：
5 秒

输入：
最大 5MB

输出：
最大 2MB

Variable table：
最大 5000 行
最大 200 列

Renderer：
最大 2000 cells
```

禁用：

```text
Date
Math.random
动态模块
网络
文件
异步任务
```

Sandbox Worker 超时：

直接 Kill Worker。

不得拖死 Agent Host。

---

# 21. Domain Tools

Agent 只开放以下 Tool。

## get_project_context

输入：

```json
{
  "projectId": "..."
}
```

返回：

```text
Project revision
Documents summary
Sources summary
Variables summary
Bindings summary
```

不返回完整数据。

---

## inspect_source

输入：

```json
{
  "sourceId": "...",
  "mode": "schema|sample|stats",
  "limit": 20
}
```

返回：

```text
schema
rowCount
columnCount
sample
basic stats
sourceRevision
```

限制 Sample 大小。

---

## inspect_variable

返回：

```text
Variable metadata
Transform
Columns
Result summary
Sample
Variable revision
```

---

## inspect_binding

返回：

```text
bindingId
description
renderer
bindingRevision
target metadata
```

---

## inspect_target

Target Snapshot 来自 WPS。

返回：

```text
kind
rowCount
columnCount
existing header
existing text
targetRevision/fingerprint
```

---

## run_transform_candidate

输入：

```json
{
  "sourceId": "...",
  "code": "..."
}
```

执行：

```text
Normalize
↓
Sandbox
↓
Deterministic Validation
```

返回：

成功：

```json
{
  "ok": true,
  "resultRef": "...",
  "valueType": "table",
  "columns": [],
  "rowCount": 10,
  "sample": []
}
```

失败：

```json
{
  "ok": false,
  "error": {
    "code": "SCRIPT_NO_RETURN",
    "message": "...",
    "hint": "..."
  }
}
```

---

## inspect_result

Agent 不在 Session 中保存完整数千行结果。

通过：

```text
resultRef
```

按需查看：

```text
schema
sample
rowCount
stats
```

---

## run_renderer_candidate

输入：

```text
variableId
bindingId / targetSnapshotId
code
```

返回：

```text
RenderPlanRef
kind
rows
columns
preview summary
```

---

## validate_candidate

执行确定性校验：

```text
Schema
字段完整性
列数
数据类型
目标兼容性
Revision
Target fingerprint
```

---

## propose_memory_update

只产生：

```text
PendingMemoryDelta
```

不直接写文件。

---

# 22. Agent Loop

变量生成流程：

```text
User Intent
     ↓
Resume/Create Variable Session
     ↓
Inject memory.md
     ↓
Inject Fresh State
     ↓
Agent
     ↓
inspect_source
     ↓
generate Transform
     ↓
run_transform_candidate
     ↓
失败？
 ├── yes
 │     ↓
 │  Structured Tool Error
 │     ↓
 │  Agent 修复
 │     ↓
 │  再次 run
 │
 └── no
       ↓
inspect_result
       ↓
validate_candidate
       ↓
Semantic Critic
       ↓
通过？
 ├── no → reason 回到当前 Session → repair
 └── yes
       ↓
Preview
```

---

# 23. Agent 自修复限制

为了避免失控：

```text
一个 Agent Run：

最大 Candidate Execution：5

最大 Agent Turns：8

最大 Semantic Repair：2

总运行上限：
由 Host 配置控制
```

超过限制：

停止。

UI 显示：

```text
AI 无法自动完成这个要求。

最后错误：
...

可以：
修改要求
查看执行详情
重新尝试
```

不要无限循环。

---

# 24. Critic

Critic 不继承 Variable Session。

必须使用：

```text
stateless context
```

输入仅包括：

```text
当前用户要求
当前 Source Schema / Evidence
Candidate Script
实际完整执行结果摘要
当前 Target
Validation Result
```

不提供：

```text
Agent之前怎么想的
Agent为什么这样写
Agent历史解释
```

避免 Critic 被 Generator 的思路带偏。

---

# 25. Critic 结果

结构：

```json
{
  "passed": false,
  "issues": [],
  "repairInstruction": ""
}
```

默认：

```text
Critic failed
→ 返回 Variable Agent Session
→ 自动修复
```

如果连续失败达到上限：

允许用户：

```text
查看 Preview，但显示高风险警告
```

最终保存仍由用户决定。

---

# 26. Tool Result 不能把大数据塞进 Session

禁止：

```text
Tool Result:
5000 行 Excel JSON
```

Session 只保留：

```text
resultRef
schema
rowCount
summary
limited sample
checksum
```

例如：

```json
{
  "resultRef": "result_abc",
  "rowCount": 5324,
  "columns": ["部门","预算"],
  "sample": [...]
}
```

完整结果存在：

```text
Result Store
```

---

# 27. Result Store

目录：

```text
data/
  results/
    result_xxx.json
```

Result 是临时对象。

包含：

```text
sourceRevision
scriptHash
runtimeVersion
result
createdAt
```

默认：

```text
Draft commit 后清理
```

或保留有限时间做 diagnostics。

---

# 28. Pi Compaction

直接复用 Pi Compaction。

不要自行重新发明 Session Summary。

Pi 当前 Session 本身支持树状历史和 Compaction；自动压缩时保留最近上下文，同时用摘要代替更老历史。

我们的 Compaction Prompt 必须强调保留：

```text
用户最初目标
用户明确纠正
已确认业务规则
未解决问题
重要 Tool Error
当前 Candidate 演进原因
```

但：

```text
Compaction Summary
```

永远不是业务真相。

每一轮仍重新注入：

```text
memory.md
Fresh State
```

Pi 的 Session/Compaction 负责“发生过什么”，Project Store 负责“现在是什么”。

---

# 29. Pi Session Tree

Session 保留 Pi 原生：

```text
id
parentId
```

第一阶段 UI 不暴露完整 `/tree`。

但是保存：

```text
variableRevision
→ sessionEntryId
```

映射。

未来用户：

```text
恢复 Variable Revision 3
```

以后如果点击：

```text
“从这个版本继续修改”
```

可以从对应 Entry 创建 Branch。

第一阶段不是必须的 UI 功能，但数据不能丢。

---

# 30. Project Store

Node Agent Host 是唯一写入者。

初期继续兼容现有：

```text
state.json
```

模型。

不急于引入 SQLite。

Node 内部所有状态更新使用：

```text
in-memory state
↓
validate
↓
temp file
↓
fsync where applicable
↓
atomic rename
```

防止异常退出导致 state.json 半写。

---

# 31. 并发模型

允许：

```text
不同 Variable
并行 Agent Run
```

但限制：

```text
default maxConcurrentAgents = 2
```

同一个 Variable：

```text
同一时刻最多一个 Agent Run
```

否则返回：

```text
VARIABLE_AGENT_BUSY
```

Project Store Commit：

使用 Project-level write mutex。

---

# 32. 多个 WPS 进程

WPS ET：

```text
127.0.0.1:17891
```

WPS WPP：

同一个地址。

所有实例连接：

```text
同一个 Node Agent Host
```

所以不存在：

```text
多个 WPS 同时写 Session 文件
```

Node 是唯一写入者。

---

# 33. Source 整行 / 整列支持

ET Adapter 必须增加：

```text
Selection Resolver
```

区别：

```text
normal range
whole rows
whole columns
whole sheet
```

例如：

```text
Selection = A:G

UsedRange = A1:K800

effectiveRange = A1:G800
```

Source 保存：

```ts
{
  requestedAddress: "$A:$G",
  effectiveAddress: "$A$1:$G$800",
  selectionMode: "whole-columns"
}
```

刷新 Source 时：

重新计算 effectiveRange。

因此新增第 801 行能自动进入 Source。

---

# 34. Model Provider

Agent Host 保存：

```text
baseUrl
apiKey
model
reasoning/thinking configuration
compat configuration
```

通过 Pi 自定义 OpenAI-compatible Provider 使用：

```text
api = openai-completions
```

支持：

```text
OpenAI
DeepSeek
Qwen
vLLM
LM Studio
Ollama compatible
企业内部模型网关
```

不得要求用户修改：

```text
~/.pi/agent/models.json
```

本产品通过代码创建自己的 Model Runtime。

---

# 35. API Key 安全

API Key：

只存在 Node Agent Host。

绝不返回 WPS WebView。

设置接口：

```text
POST /api/settings/ai
```

WPS 发送一次新 Key。

以后：

```text
GET /api/settings
```

只返回：

```json
{
  "apiKeyConfigured": true
}
```

不得返回：

```text
••••••••
```

更不能返回真实 Key。

---

# 36. API Key 本地存储

数据目录权限：

macOS：

```text
0700 directory
0600 secrets
```

Windows：

Installer 应设置当前用户 ACL。

Secret 单独存储：

```text
data/secrets/ai.json
```

不进入：

```text
state.json
session.jsonl
diagnostics
memory.md
```

后续可以升级系统 Keychain / Credential Manager。

但不是第一阶段依赖。

---

# 37. Local HTTP Security

监听：

```text
127.0.0.1
```

禁止：

```text
0.0.0.0
```

保留 local origin CORS allowlist。

启动生成：

```text
runtime auth token
```

所有业务 API：

```text
X-RA-Token
```

验证。

AI Key 永远不通过：

```text
health
logs
trace
```

返回。

---

# 38. Agent Tools 没有破坏性副作用

这是整个安全设计的重要原则。

Agent Tool 可以：

```text
inspect
calculate
validate
propose
```

不能：

```text
save_variable
delete_variable
write_ppt
write_excel
edit_file
shell
network
```

因此即使：

```text
Agent 崩溃
Pi replay
Session resume
```

也不会重复修改用户文档。

---

# 39. WPS 写入事务

真正修改 WPS 继续保持：

```text
Preview
↓
用户点击确认
↓
capture Before
↓
WPS Adapter apply RenderPlan
↓
capture After
↓
Agent Host Commit Binding + Change
```

AI 不参与最后写入。

---

# 40. Stale Target 防护

生成 RenderPlan 时保存：

```text
targetFingerprint
```

用户确认 Apply 前：

WPS 重新计算当前 Target Fingerprint。

如果不同：

```text
TARGET_CHANGED
```

禁止应用旧 Preview。

提示：

```text
目标对象已经变化，请重新生成预览。
```

---

# 41. Variable Revision 防护

Candidate 基于：

```text
sourceRevision = 12
variableRevision = 7
```

Commit 时必须再次确认。

如果当前：

```text
sourceRevision = 13
```

返回：

```text
STALE_SOURCE_REVISION
```

禁止提交。

---

# 42. Agent Run 状态

每一次 Agent 工作生成：

```ts
AgentRun {
  id
  projectId
  variableId / draftId

  sessionId

  status:
    queued
    running
    waiting_tool
    reviewing
    preview_ready
    failed
    cancelled

  startedAt
  finishedAt
}
```

---

# 43. SSE Agent Progress

WPS UI 订阅：

```text
GET /api/agent/runs/:runId/events
```

事件例如：

```text
agent_started

inspecting_source

candidate_generated

candidate_execution_started

candidate_execution_failed

candidate_repairing

candidate_validated

critic_started

preview_ready
```

UI 不展示模型内部 Chain-of-Thought。

只展示任务状态。

例如：

```text
正在检查数据结构…
正在生成处理规则…
第一次执行失败，AI 正在修复…
规则验证通过…
正在进行语义复核…
```

---

# 44. Diagnostics

每个 Agent Run 保存结构化 Trace：

```text
runId
sessionId
variableId
model
duration
toolCalls
toolErrors
candidateHashes
validation
critic
tokenUsage
```

默认不保存：

```text
API Key
完整 Source Data
完整 Result
完整敏感表格
```

诊断导出如果包含业务数据：

必须让用户主动勾选。

---

# 45. 目录结构

建议仓库：

```text
wps-report-assistant/

  agent-host/
    package.json
    tsconfig.json

    src/

      main.ts

      server/
        http-server.ts
        routes/
        sse.ts
        auth.ts

      project/
        store.ts
        models.ts
        revisions.ts
        drafts.ts
        migrations.ts

      agent/
        runtime.ts
        session-registry.ts
        context-builder.ts
        system-prompt.ts
        critic.ts
        memory-manager.ts

        tools/
          get-project-context.ts
          inspect-source.ts
          inspect-variable.ts
          inspect-binding.ts
          inspect-target.ts
          run-transform.ts
          run-renderer.ts
          inspect-result.ts
          validate-candidate.ts
          propose-memory-update.ts

      sandbox/
        client.ts
        worker.ts
        normalize-script.ts
        contracts.ts

      model/
        provider.ts
        settings.ts

      diagnostics/
        traces.ts
        redact.ts

      legacy/
        transform-dsl.ts
        renderer-dsl.ts

  addins/
    et/
    wpp/
    wps/

  shared/
    contracts/

  installer/

  tests/
```

---

# 46. Shared Contracts

把现在 Go / JS 分散定义的合同统一成 TypeScript：

```text
Source
Variable
Binding
TransformResult
RenderPlan
AgentToolError
Draft
Revision
TargetSnapshot
```

建议：

```text
shared/contracts
```

同时用于：

```text
Agent Host
WPS Addin
Tests
```

这是迁移 TS 最大的收益之一。

---

# 47. 错误合同

所有 Tool Error 必须结构化。

例如：

```ts
type ToolErrorCode =
  | "SCRIPT_SYNTAX"
  | "SCRIPT_CONTRACT_ERROR"
  | "SCRIPT_NO_RETURN"
  | "SCRIPT_TIMEOUT"
  | "SCRIPT_RESULT_TOO_LARGE"
  | "RESULT_SCHEMA_INVALID"
  | "SOURCE_SCHEMA_CHANGED"
  | "STALE_SOURCE_REVISION"
  | "STALE_VARIABLE_REVISION"
  | "TARGET_CHANGED"
  | "MODEL_ERROR"
  | "TOOL_INTERNAL_ERROR";
```

返回：

```json
{
  "code": "SCRIPT_NO_RETURN",
  "message": "Renderer 没有返回 RenderPlan",
  "hint": "必须从 render(variable,target) 返回 {kind:'text'...} 或 {kind:'table'...}"
}
```

AI 应该看到的是这种错误。

不是：

```text
结果包含不能保存的值
```

---

# 48. legacy 兼容

当前旧项目可能包含：

```text
Transform DSL
Renderer DSL
Dynamic Capability
旧 JavaScript Spec
```

新架构：

不得继续让 AI 生成旧 DSL。

但必须读取已有项目。

建立：

```text
legacy/
```

只负责：

```text
read
execute
migration
```

不负责：

```text
new generation
```

新增 Variable 一律使用新 JS Contract。

---

# 49. 当前 Go Core 的迁移原则

不是逐文件 TypeScript 翻译。

分类：

## 保留业务能力，重新实现

```text
store.go
drafts.go
variable_revisions.go
changes.go
render.go
javascript.go
server.go
```

## 被 Pi 替代

```text
chatJSON()
AI retry loop
AI trace conversation management
GenerationAttempt orchestration
manual context management
```

## Legacy Compatibility

```text
contract.go
transform.go
capability_runtime.go
reliable_ai.go
semantic_critic.go 中旧 DSL 部分
```

只搬真正还需要执行历史数据的部分。

---

# 50. Installer

第一阶段不用重写 Installer。

当前 Installer 已经具备：

Windows：

```text
HKCU Run
```

macOS：

```text
LaunchAgent
```

只需要把启动目标：

```text
DataReportAssistantCore
```

替换成：

```text
Node Runtime
+
agent-host bundle
```

例如 Windows：

```text
runtime/node.exe
app/agent-host.mjs
```

macOS：

```text
runtime/node
app/agent-host.mjs
```

用户不感知 Node。

---

# 51. 单文件打包不是第一优先级

初期正式结构允许：

```text
app/
  runtime/
    node
  agent-host/
    agent-host.mjs
  sandbox/
    quickjs.wasm
```

先保证：

```text
稳定
可诊断
可升级
```

之后再评估：

```text
Node SEA
Bun compile
```

是否值得把 Agent Host 合成单文件。

不能为了少几十 MB 提前增加运行时风险。

---

# 52. Crash Recovery

Agent Host 崩溃：

```text
Pi Session 已持久化
Draft 已持久化
Project State 未 Commit
```

重启后：

```text
Run 标记 interrupted
```

用户可以：

```text
继续
重新生成
取消
```

因为 Agent Tool 没有 WPS 写副作用，所以恢复安全。

---

# 53. memory.md 与 Compaction Recovery

重新启动 Variable Session：

加载顺序：

```text
1. Project Store
2. Variable
3. memory.md
4. Pi Session
5. Pi Compaction
6. Current State Snapshot
```

如果 memory 中：

```text
sourceRevision = 8
```

当前：

```text
sourceRevision = 15
```

Context Builder 应告诉 Agent：

```text
memory 中的 revision 已经过期。

不要使用其中的动态数据；
只保留用户确认过的业务语义。
```

---

# 54. 测试要求

## Unit

必须覆盖：

```text
Variable → Session mapping

Draft Session → Variable Session

memory update commit/cancel

Script normalization

Sandbox timeout

Sandbox no Node access

Tool Result reduction

Revision conflict

Target fingerprint

API Key redaction
```

---

# 55. Agent Regression Tests

使用 Fake Model / scripted responses。

至少覆盖：

### Case A — 当前真实 Bug

AI：

```js
function render(variable,target) {
   return {...};
}
```

必须：

```text
成功执行
```

不能再：

```text
undefined
```

---

### Case B — Syntax Error

第一次：

```text
JS syntax error
```

Tool 返回：

```text
SCRIPT_SYNTAX
```

Agent 第二次修复成功。

---

### Case C — Schema Error

Agent 使用：

```text
去年预算
```

但当前 Source 只有：

```text
本年预算
```

Tool 失败。

Agent必须重新：

```text
inspect_source
```

而不是猜字段。

---

### Case D — Session Resume

第一次：

```text
用户：
按本年预算排序
```

退出应用。

重启。

用户：

```text
“改成升序”
```

必须恢复同一个 Variable Session。

---

### Case E — memory

用户纠正：

```text
“正式员工字段不是状态，是员工类型”
```

确认保存。

重启。

memory.md 必须保留此决定。

---

### Case F — Fresh State

Session 历史说：

```text
Source Revision 4
```

实际为：

```text
Revision 9
```

Agent 必须使用 Revision 9。

---

### Case G — Binding isolation

同一个 Variable：

```text
Binding A：万元
Binding B：元
```

修改 B 时不能继承 A 的单位。

---

### Case H — Large Source

5000 行。

Session 中不能出现完整 5000 行 Tool Result。

---

# 56. WPS 验收场景

最终必须真实 WPS 验收：

```text
Excel普通区域
Excel整行
Excel整列

Variable创建

故意制造第一次Agent失败
验证Agent自动修复

关闭WPS
关闭Agent Host
重新启动
继续修改Variable

同Variable绑定两个PPT目标

Source数据更新

Source Schema变化

PPT Target变化

Apply

Undo

并发打开ET和WPP
```

---

# 57. 最终删除条件

以下全部通过后才能删除 Go Core：

```text
Project migration test 100% pass

现有 state.json 可加载

现有 Variable 可重新计算

现有 Binding 可重新 Render

Change History 可读取

Windows WPS 验收通过

macOS WPS 验收通过

Agent Session Resume 通过

API Key 不进入 WebView

Sandbox 安全测试通过
```

在此之前：

```text
core-go/
```

保留作为对照实现。

---

# 58. 实施顺序

按依赖关系实施：

```text
① shared/contracts

② TypeScript Project Store
   能无损读取当前 state.json

③ Node HTTP Server
   保持现有 API 基本兼容

④ Sandbox Worker

⑤ Pi Runtime
   禁用全部 Coding Tools

⑥ Domain Tools

⑦ Variable Session Registry

⑧ memory.md

⑨ Transform Agent Loop

⑩ Stateless Critic

⑪ Binding / Renderer Agent

⑫ SSE Agent Progress

⑬ ET / WPP 接入

⑭ Legacy compatibility

⑮ Installer 切换 Node Host

⑯ 完整回归

⑰ 移除 Go Runtime
```

不要先大规模重写 UI。

先把：

```text
ET/WPP → localhost API
```

合同保持兼容。

这样 Agent Core 可以独立替换。

---

# 59. 最终数据流

## Variable

```text
Excel Selection
       ↓
Effective Range
       ↓
Source Draft
       ↓
Variable Draft
       ↓
Create / Resume Pi Session
       ↓
memory.md
+
Fresh Project State
       ↓
Variable Agent
       ↓
Domain Tools
       ↓
QuickJS Sandbox
       ↓
真实完整数据执行
       ↓
Validator
       ↓
Stateless Critic
       ↓
Preview
       ↓
User Confirm
       ↓
Commit Source
+
Variable
+
Memory Delta
```

## Binding

```text
Variable
+
PPT Target Snapshot
+
User Intent
       ↓
Resume Variable Session
       ↓
inspect_binding
inspect_target
       ↓
Agent
       ↓
run_renderer_candidate
       ↓
Sandbox
       ↓
RenderPlan
       ↓
Validator
       ↓
Critic
       ↓
Preview
       ↓
User Confirm
       ↓
Before Snapshot
       ↓
WPS Apply
       ↓
After Snapshot
       ↓
Binding / Change Commit
```

---

# 60. 架构底线

后续实现不得突破以下边界。

### 1

```text
Session 保存“发生过什么”。
Project Store 保存“现在是什么”。
```

### 2

```text
一个 Variable 对应一个长期 Pi Session。
```

### 3

```text
memory.md 保存稳定语义，
不保存实时业务事实。
```

### 4

```text
Agent 只能 inspect / calculate / validate / propose。
```

### 5

```text
Agent 永远不能直接修改 WPS。
```

### 6

```text
所有 AI 生成代码必须进入独立 Sandbox。
```

### 7

```text
API Key 只存在 Node Agent Host。
```

### 8

```text
WPS ET / WPP 永远不直接写 Project / Session 文件。
```

### 9

```text
Tool Error 必须结构化，
并足以让 Agent 自动修复。
```

### 10

```text
Pi 是 Runtime 依赖，
不是产品业务模型。
```

必须通过：

```text
AgentRuntime
SessionRegistry
ModelProvider
DomainTool
```

等我们自己的接口隔离 Pi。

以后即使 Pi 替换：

```text
Project Store
Variable
Binding
memory.md
WPS UI
```

都不应该被迫重写。

---

# 61. 目标结果

完成本 SPEC 后，用户体验应变成：

用户第一次：

> 创建“部门预算Top10”，只统计正式员工，按本年预算倒序。

Agent 自动：

```text
理解字段
→ 写 Transform
→ 完整数据执行
→ 发现错误
→ 自己修复
→ 校验
→ 语义复核
```

用户只看到最终 Preview。

几天以后：

> “部门预算Top10”改一下，预算变成升序。

系统：

```text
Variable
→ 原 Pi Session
→ memory.md
→ 最新 Source
→ 最新 Variable State
```

Agent 明白：

```text
这个 Variable 是什么
用户以前纠正过什么
我以前遇到过什么问题
```

同时又不会错误相信旧数据。

这就是本次 Pi + TypeScript 重构最终要解决的问题。
