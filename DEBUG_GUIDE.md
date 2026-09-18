# 数据报告助手 v0.4 调试口径

## 目标

变量提取和 PPT 渲染后续会快速扩展。为了避免“结果不对”只能靠截图猜，本版本把一次完整操作拆成 8 个可追踪阶段，并使用同一个 `traceId` 串起来。

1. `selection`：WPS Excel 实际选中了什么。
2. `ai-transform`：AI/内置规则看到了什么，生成了什么 TransformSpec。
3. `transform`：Core 执行了哪条确定性规则。
4. `result`：规则真实产出了什么数据结果。
5. `target`：WPS PPT 实际选中了哪个 Shape。
6. `ai-binding`：AI/默认逻辑生成了什么 Renderer。
7. `render-plan`：Core 最终准备写入 PPT 的文本/表格内容。
8. `apply`：WPS 最终写入是否成功。

之后讨论任何问题，优先指出“哪一个阶段与预期不一致”，避免把 AI 理解、数据计算和 WPS 写入混为一谈。

## 开启方法

WPS → 数据报告助手 → 设置 → 调试与诊断：

- 启用“调试模式”。
- 使用标准测试数据时建议勾选“诊断包包含业务数据”。
- 使用真实业务文件时可不勾选，诊断包会用尺寸 + SHA256 替代源数据、变量值和敏感 AI Trace。
- API Key 永远不会导出。

## 一键准备标准测试项目

点击“准备标准测试项目”。Core 会把以下文件复制到：

`%USERPROFILE%\Documents\DataReportAssistant-标准测试项目`

并创建/复用项目“标准测试项目”：

- 标准测试-本年预算.xlsx
- 标准测试-历史预算.xlsx
- 标准测试-预算汇报.pptx
- 调试步骤.md

文件夹会自动打开。直接用 WPS 打开这些文件即可，插件应自动识别项目，无需再次手工加入。

## 标准 Case

### Case A：标量 → PPT 文本

Excel `本年预算!A1:G15`：

`只保留状态为正式的数据，计算预算金额合计。`

PPT 第 2 页文本框：

`按亿元显示，保留2位小数，后缀为“亿元”。`

重点核对：`selection → ai-transform → result → target → ai-binding → render-plan → apply`。

### Case B：分组表格 → PPT 表格

Excel `本年预算!A1:G15`：

`只保留状态为正式的数据，按部门汇总预算金额和实际金额，按预算金额降序。`

PPT 第 3 页表格：

`第一列部门，第二列预算金额，第三列实际金额；金额按万元显示，不改变列数，数据行随结果增减。`

重点核对：Transform 是否 groupAggregate；RenderPlan 行列数是否正确；WPS Apply 是否成功增删行。

### Case C：Top5

Excel：

`只保留正式数据，按部门汇总预算金额，按预算金额降序取前5名。`

绑定 PPT 第 4 页表格。

重点核对：Transform 中是否包含 filter / groupAggregate / sort / limit。

## 一键导出诊断包

复现问题后立即打开设置，点击“导出诊断包”。Windows 会自动定位生成的 ZIP。

ZIP 包含：

- `SUMMARY.md`：自动整理的阶段统计与最近错误。
- `environment.json`：Core 版本、平台、项目。
- `settings.safe.json`：设置快照，API Key 已强制删除。
- `project.json`：当前项目的 Document / Source / Variable / Binding 结构。
- `events.jsonl`：按时间顺序记录完整 Trace。

默认文件名：

`DataReportAssistant-Diagnostic-项目名-YYYYMMDD-HHMMSS.zip`

## 我们之后对齐问题时的最简格式

只需要提供两样：

1. 诊断 ZIP。
2. 一句话，例如：“Case B，第 3 页表格最终只有 3 行，预期 10 行。”

然后优先按以下顺序判断：

- Selection 错 → WPS 上下文捕获层。
- AI Transform 错 → AI Prompt / TransformSpec 层。
- Result 错 → Transform Engine。
- Target 错 → PPT Shape 定位层。
- Binding 错 → AI Renderer 规则层。
- RenderPlan 错 → Renderer Core。
- RenderPlan 对但 PPT 错 → WPS Apply 层。

这套口径是后续扩展图表、多 Excel 联合计算、AI 通读 PPT 的基础。
