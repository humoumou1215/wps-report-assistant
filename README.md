# 数据报告助手 v0.8.0-js1

通用 WPS 数据工作区：通过宿主能力读取和写入内容，文件扩展名不决定输入或输出方向。当前包含：

- WPS 表格、文字、演示共用的“项目数据 / 输出 / 修改历史”侧栏
- 单元格、文字选区、幻灯片对象的读写适配与可扩展能力注册表
- 本地 Go Core
- Windows 安装器与 macOS LaunchAgent 安装器
- 标准测试数据与验证清单

本版默认使用 **AI 编写 JavaScript → Core 使用完整真实数据执行 → 预览 → 用户确认 → WPS 写入与历史撤销**。旧 Transform/Renderer DSL 仍保留用于已有项目兼容和 AI 不可用时的 fallback，但不再是新生成的默认路径。

请先阅读 [JavaScript 版本验收](JAVASCRIPT_VALIDATION.md)。

## 默认执行模型

### 变量生成

```text
用户要求
+
WPS 数据结构 / 数据证据
        ↓
AI 生成 JavaScript
        ↓
JavaScript 基本检查
        ↓
Sandbox Worker
        ↓
使用完整真实数据执行
        ↓
执行失败？
 ├─ 是 → previousCode + executionError → AI 修复 → 重新执行
 │                                      （最多 3 次）
 └─ 否
        ↓
TransformResult
        ↓
AI Critic 建议性复核
        ↓
Preview
        ↓
用户确认
        ↓
Source + Variable
```

变量预览入口是 `POST /api/projects/:id/variables/preview`，Core 通过 `BuildTransform` 调用 JavaScript 主链路。AI 只负责编写程序，不负责直接写入变量或修改文档；正式结果由 Core 对完整输入执行后产生。

### PPT 输出

```text
Variable + PPT Target + 用户展示要求
        ↓
AI 生成 Renderer JavaScript
        ↓
Sandbox 执行
        ↓
RenderPlan
        ↓
Preview
        ↓
保存 Before Snapshot
        ↓
WPS Adapter 写入原稿
        ↓
保存 After Snapshot
        ↓
Binding + Change History
```

Binding 预览入口是 `POST /api/projects/:id/bindings/preview`。AI 不直接调用 WPS API；修改文字、填充表格和改变 shape 内容等操作都由 WPS Adapter 执行。

### 三层职责

- **AI**：根据用户要求和数据证据编写受限 JavaScript，必要时根据执行错误修复代码。
- **Core**：检查、沙箱执行程序，生成 `TransformResult` 或 `RenderPlan`，并负责预览、校验与持久化。
- **WPS Adapter**：读取真实数据、应用用户确认后的修改、保存前后快照并支持撤销。

当 Source 更新时，Core 会重新执行所有依赖的 Variable；只有全部成功，才一次性提交新的 Source 与 Variables，避免出现 Source 已更新而部分 Variable 仍为旧数据的状态。

## AI Critic 与安全边界

AI Critic 对照用户要求、实际结果和目标对象提供建议性复核。它不替代 Core 的执行结果，也不直接修改 WPS 内容。

默认 JavaScript 只能使用显式传入的数据和标准 JavaScript，不能访问文件、网络、进程、注册表、`require`、`process`、WPS COM 或宿主 API。脚本只能返回变量结果或受控的 text/table RenderPlan。

## Legacy compatibility

旧 Transform/Renderer DSL、Graph 和 Dynamic Capability 目前仅用于：

1. 已有项目和历史数据兼容；
2. AI 未配置时的 deterministic fallback；
3. 部分历史数据迁移和兼容性校验。

它们不是 v0.8.0-js1 的默认新生成路径。新增默认 AI 生成行为应放在 `core-go/javascript_ai.go`；`core-go/reliable_ai.go` 只维护 legacy deterministic / DSL 兼容路径。

临时动态能力默认关闭。若确需启用，它仍运行在 Core 的受限数据沙箱中，Apply 前需要用户确认高风险提示，且不能获得文件、网络、进程或 WPS 权限。

## 通用工作区与 macOS

- [安装与真实 WPS 验收步骤](MACOS_VALIDATION.md)：本地安装包、用户操作清单和已验证范围。
- [宿主能力扩展接口](HOST_CAPABILITIES.md)：新增读取、写入、快照与恢复能力的方法。
- [直接修改与撤销](CHANGE_HISTORY.md)：修改前后对比、异常恢复与撤销规则。

## 安装

1. 完全退出 WPS 表格和 WPS 演示。
2. 运行对应版本的 `DataReportAssistant-Setup` 安装包；当前主线版本为 `v0.8.0-js1`。
3. 安装完成后重新打开 WPS。
4. 在插件设置中配置 OpenAI-compatible 模型地址、模型和 API Key。
5. 按需开启 AI 语义审查；临时动态能力默认关闭。

详细步骤见 `VALIDATION_GUIDE.md`。

## PPT 修改历史

插件支持在原稿上应用修改、检查修改前后内容，并按时间倒序撤销。已有绑定可通过“检查与调整”修改展示要求。当前可撤销范围及 Windows 验证步骤见 [CHANGE_HISTORY.md](CHANGE_HISTORY.md)。

## 开发验证

```bash
cd core-go
go test ./...
go test -race ./...
go vet ./...

cd ..
node --check addins/et/common.js
node --check addins/et/taskpane.js
node --check addins/wpp/common.js
node --check addins/wpp/taskpane.js
node --check addins/wpp/change-history.js
node --check addins/wpp/change-state.js
```

实际 WPS COM/JS 宿主行为必须在 Windows WPS 中做最终人工验证。
