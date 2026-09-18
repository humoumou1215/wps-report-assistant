# v0.7.0-rc1 开发侧验证结果

验证时间：2026-09-18。

## 已通过

### Core

- `go test ./...`：通过。
- `go test -race ./...`：通过。
- `go vet ./...`：通过。
- Windows amd64 Core 交叉编译：通过，产物识别为 PE32+ x86-64 GUI executable。

### 新架构回归

自动测试已覆盖：

- AI 第一轮引用不存在字段，确定性 Contract/Graph 校验拒绝并自动修复。
- Transform 能力前后类型不匹配时，不进入完整执行。
- Renderer 引用不存在字段时，在快速校验阶段拒绝。
- AI 选中了“存在但业务语义错误”的字段时，Critic 拒绝并让生成器修复。
- 金额单位“亿元”语义错误时，Critic 拒绝错误 Renderer 并验证修复结果。
- Top5 表格旧问题：普通 Renderer 漏掉“序号”后，Critic 识别语义缺口；动态能力生成计算列，RenderPlan 表头为“序号 / 部门 / 预算金额”，行号为 1..5。
- “序号从 10 开始”使用相同通用沙箱表达式完成，结果为 10、11……，没有新增固定 index/start Contract。
- 动态 Transformer 计算列通过 Graph Validate + 快速试跑，并得到预期结果。
- 动态能力降序排序正确。
- 动态 Renderer 引用不存在字段时，快速校验失败。
- 动态 Variable/Binding Draft 未二次人工确认时，Core 返回 HTTP 412；明确确认后才允许 Apply。

### WPS 前端静态检查

以下脚本均通过 `node --check`：

- `addins/et/common.js`
- `addins/et/taskpane.js`
- `addins/wpp/common.js`
- `addins/wpp/taskpane.js`

### Installer

- installer helper tests：通过。
- Windows amd64 Setup 交叉编译：通过，产物识别为 PE32+ x86-64 GUI executable。
- 安装器 payload 已从最终源码重新刷新，包含最终 Core、ET/WPP addins、samples、README 和验证指南。

### 实际 Core HTTP 冒烟

使用最终代码启动本地 Core：

- `/api/health` 返回 `version=0.7.0-rc1`。
- `/api/capabilities` 返回内置 transform/render 能力和 sandbox 能力。
- “只保留状态为正式的数据，计算预算金额合计” Preview 成功，结果为 300（冒烟小数据）。
- Preview 前 Source/Variable 数量保持 0/0。
- Apply 后才变为 1/1。
- Graph Validate 为通过。

## 当前环境无法替代的人工验证

当前构建环境不是 Windows WPS，因此不能真实驱动 WPS JS/COM 宿主。以下内容需要用户在 Windows WPS 中做最终验证：

- Ribbon/任务窗格真实加载；
- Excel 当前 Selection 读取；
- PPT Shape/Table 写入；
- 真实 Top5 模板中“序号”列不被覆盖；
- WPS 对表格增删行的兼容行为。

这些人工项已写入 `VALIDATION_GUIDE.md`。如果失败，请开启调试后导出诊断 ZIP；本版诊断会包含 Execution Graph、快速试跑、Critic 和 Dynamic Capability 信息。

## 动态能力安全边界

AI 动态能力使用 `ra-cap-v1` 数据沙箱，不执行任意 JS/Go/Shell，也不能访问文件、网络、进程、注册表或直接调用 WPS COM。它可以现场生成新的数据计算/展示组合逻辑，但不能自行提升宿主权限。这个边界是有意保留的。
