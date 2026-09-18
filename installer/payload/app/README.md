# 数据报告助手 v0.7.0-rc1

这是一个可直接安装到 Windows + WPS 的完整验证版本，包含：

- WPS 表格（ET）任务窗格
- WPS 演示（WPP）任务窗格
- 本地 Go Core
- Windows 安装器
- 标准测试数据与验证清单

本版的重点不是继续扩充一份越来越大的 Transform/Renderer 固定契约，而是把 AI 生成过程改成 **能力组合 → 快速验证 → 确定性执行 → AI 语义审查 → 必要时修复/临时能力 → 用户确认 → Apply**。

## 核心执行模型

### 1. AI 负责规划，不参与确定性执行

变量计算链路：

```text
用户需求 + Excel 数据结构
        ↓
AI 生成 Transform Plan
        ↓
编译 Execution Graph
        ↓
Schema / 能力图 / 快速试跑
        ↓
Transformer Runtime 确定性执行
        ↓
Variable
        ↓
AI Critic 对照用户原始要求审查实际结果
        ↓
Preview → 用户确认 → 保存 Source + Variable
```

PPT 绑定链路：

```text
用户需求 + Variable + 当前 PPT 目标对象快照
        ↓
AI 生成 Renderer Plan
        ↓
编译 Execution Graph
        ↓
Schema / 能力图 / 快速试跑
        ↓
Renderer Runtime 确定性生成 RenderPlan
        ↓
AI Critic 对照用户原始要求和目标模板审查实际 RenderPlan
        ↓
Preview → 用户确认 → 保存 Binding → WPS 确定性写入 PPT
```

AI 不在 Transformer/Renderer 的逐行计算或 WPS 写入过程中临时“自由发挥”，因此同一份已保存规则可以重复执行、调试和审计。

## 快速 Graph Validate

每一个新生成的 Transform/Renderer 在进入完整流程前都会先：

1. 检查使用的能力是否存在；
2. 检查前后节点输入/输出数据类型是否可连接；
3. 校验字段/参数；
4. 用当前数据做一次无副作用快速试跑；
5. 检查试跑输出的数据类型和字段结构。

因此“组合本身跑不通”的错误不会留到最后写 PPT 才发现。

## 语义 Critic

程序校验只负责能确定的事实，例如字段存在、类型正确、能力可以执行。

“是否真的满足用户这句话”由独立 AI Critic 判断。Critic 会同时看到：

- 用户原始要求；
- 实际执行图；
- Transformer/Renderer；
- 实际变量结果或 RenderPlan；
- PPT 目标对象快照（例如原表头“序号 / 部门 / 预算金额”）。

因此本版没有用固定 `IntentValidator` 去穷举“序号、排名、第一页、Top5”等自然语言规则。

## AI 临时能力

设置中新增 **“允许 AI 创建临时沙箱能力”**，默认关闭。

当 Critic 判断现有内置能力无法表达用户要求时，开启该开关后，AI 可以现场生成一个 `ra-cap-v1` 临时能力程序。当前沙箱支持通用的：

- 行筛选、映射、排序、截取、聚合；
- 计算列；
- 行号/行位置/总行数；
- 数值、逻辑、条件、字符串组合表达式；
- 动态 text/table RenderPlan；
- 数值格式与单位换算。

例如不需要预先增加一个固定“序号能力”，AI 可以通过行位置表达式实现：

- 1、2、3……
- 10、11、12……
- 2、4、6……（由表达式组合）

### 安全边界

临时能力不是任意 `eval(JavaScript)`：它运行在 Core 的数据沙箱中，**不能访问文件、网络、进程、注册表，也不能直接调用 WPS COM**。它只能处理显式传入的数据并生成受控 RenderPlan。

这是刻意保留的宿主安全边界。真正新增一种“WPS 宿主原语”（例如未来尚未实现的特殊图形对象操作）仍需要受控宿主桥接能力；AI 不能自行给自己提升 OS/WPS 权限。

开启动态能力时会有一次高风险提示；某一次 Preview 实际使用了 AI 临时能力时，Apply 前还必须再次人工勾选确认。Core API 同样强制校验该确认，不能只绕过前端按钮直接 Apply。

## Top5 序号问题的修复方式

本版没有增加 `type:index` 这种专门规则。

对于：

> 第一列是序号，后面按字段名称填入

如果普通 table renderer 漏掉序号：

1. 普通 Renderer 可以通过结构校验；
2. Runtime 生成实际 RenderPlan；
3. Critic 会看到用户要求、RenderPlan 和原 PPT 表头，判定语义不满足；
4. 如果动态能力开启，AI 生成计算列程序；
5. 动态程序先通过 Graph Validate + 快速试跑；
6. Critic 再审查最终结果；
7. Preview 中展示“序号 / 部门 / 预算金额”和 1..5；
8. 用户明确确认后才写入 PPT。

同一套机制可以处理“序号从 10 开始”，不需要再新增另一条硬编码规则。

## 安装

1. 完全退出 WPS 表格和 WPS 演示。
2. 运行 `DataReportAssistant-Setup-0.7.0-rc1.exe`。
3. 安装完成后重新打开 WPS。
4. 在插件设置中配置 OpenAI-compatible 模型地址、模型和 API Key。
5. 建议保持“AI 语义审查”开启。
6. “允许 AI 创建临时沙箱能力”默认关闭；只有需要验证动态能力时再开启，并阅读风险提示。

详细步骤见 `VALIDATION_GUIDE.md`。

## 开发验证

```bash
cd core-go
go test ./...
go test -race ./...
go vet ./...
```

前端脚本可使用：

```bash
node --check addins/et/common.js
node --check addins/et/taskpane.js
node --check addins/wpp/common.js
node --check addins/wpp/taskpane.js
```

实际 WPS COM/JS 宿主行为必须在 Windows WPS 中做最终人工验证。
