# 数据报告助手 v0.6.0-rc1

这是一个可直接安装到 Windows + WPS 的完整验证版本，包含：

- WPS 表格（ET）加载项：从当前选区生成数据变量。
- WPS 演示（WPP）加载项：把变量绑定到文本框或表格。
- 本地 Go Core：项目存储、Transform/Renderer 执行、AI 调用、校验、诊断。
- Windows 安装器：安装 Core、注册 ET/WPP 加载项、配置开机启动；无需 Node.js / wpsjs / 管理员权限。
- 标准测试 Excel/PPT 与一键准备测试项目。

## v0.6.0-rc1 的核心变化

### 1. 生成改为 Preview → Apply

AI 或内置规则先生成**预览**，此时不会写项目，也不会修改 PPT。只有用户点击“确认创建变量”或“确认应用绑定”后才真正落库/写入。

### 2. AI 输出先过确定性契约校验

Transform 会检查真实字段、步骤顺序和结果类型；Renderer 会检查变量类型、目标类型、字段路径、表格列等。无效输出不会直接执行。

### 3. AI 最多自动修复 2 次

首次生成不合法时，Core 会把具体错误、真实字段和上一版输出反馈给 AI，最多共尝试 3 次。仍不合法则失败，不会保存半成品。

### 4. 用户明确的单位/精度优先于 AI

例如用户写：

`按亿元显示，保留2位小数，后缀为亿元`

即使 AI 返回了错误的 `divideBy=10000 / 万元 / 0.0`，Core 也会确定性纠正为 `100000000 / 亿元 / 0.00`。

### 5. 预览阶段不产生孤儿数据

ET 确认变量时 Source + Variable 一次提交；WPP 确认前先做目标预检，若本地写 PPT 失败，会尽量回滚刚创建的 Binding。

## 安装

1. 完全退出所有 WPS 进程。
2. 运行 `DataReportAssistant-Setup-0.6.0-rc1.exe`。
3. 安装完成后重新打开 WPS 表格或 WPS 演示。
4. 顶部应出现“数据报告助手”。

安装位置：`%LOCALAPPDATA%\DataReportAssistant\app`

项目数据与配置：`%LOCALAPPDATA%\DataReportAssistant\data`

Core 日志：`%LOCALAPPDATA%\DataReportAssistant\data\core.log`

覆盖安装不会主动删除项目数据或 AI 配置。

## 最快验证

打开插件设置，点击“准备标准测试项目”。随后按 `samples/调试步骤.md` 或根目录 `VALIDATION_GUIDE.md` 完整验证。

标准 Case A：

1. Excel 选择 `本年预算!A1:G15`。
2. 变量名：`正式预算合计`。
3. 描述：`只保留状态为正式的数据，计算预算金额合计。`
4. 变量预览应为 `66,600,000`；**确认前变量列表不应新增变量**。
5. 确认创建变量。
6. PPT 第 2 页选中金额文本框，描述：`按亿元显示，保留2位小数，后缀为“亿元”。`
7. 绑定预览应为 `0.67亿元`；**确认前 PPT 文本不应变化**。
8. 确认后 PPT 文本应更新为 `0.67亿元`。

## AI 接口

支持 OpenAI-compatible `POST /chat/completions` 接口。若未启用 AI，常见的简单筛选 + 汇总 Case 会走内置确定性兜底；复杂分组、TopN 等建议配置 AI。

## 当前验证边界

- 文本绑定：支持。
- 普通表格绑定：支持按结果调整数据行；目标表格需要预先具备足够的列数。
- 图表：本版本尚未作为正式 Renderer 能力开放。
- Preview 草稿只保存在 Core 内存，约 30 分钟后过期；Core 重启后需重新生成预览。
