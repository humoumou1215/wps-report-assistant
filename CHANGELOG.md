# Changelog

## 0.7.0-rc1

- 引入 Capability Registry 与 Execution Graph。
- 每个 AI 生成的 Transform/Renderer 在完整执行前进行 Graph Validate、类型连接检查和无副作用快速试跑。
- 将开放式自然语言正确性判断从固定 IntentValidator 主路径移出，新增独立 AI Semantic Critic。
- Critic 基于用户原始要求 + 实际执行结果/RenderPlan + PPT 目标对象快照判断语义是否满足。
- 新增 AI 自动 Repair Loop：结构错误、执行错误、语义错误都会把实际反馈返回给生成器重试。
- 新增可选 AI Dynamic Capability，使用受控 `ra-cap-v1` 数据沙箱程序动态组合计算列、筛选、排序、聚合和 table/text RenderPlan。
- Dynamic Capability 默认关闭；开启有高风险提示；每次实际使用在 Apply 前要求二次人工确认，Core API 同时强制确认。
- 修复 Top5 表格“序号列被覆盖”的架构问题：不增加固定 index Contract，而通过 Critic + 动态计算列完成。
- 支持用相同通用能力生成“序号从10开始”等变化，无需新增专门规则。
- WPP 目标采集增加表格/文本快照，让 Critic 能看到原 PPT 模板结构。
- Preview UI 增加 Execution Graph、快速校验、Critic、动态能力程序和风险确认展示。
- 保留 Preview → Apply 两阶段提交，预览时不创建 Source/Variable/Binding，也不修改 PPT。

## 0.6.0-rc1

- 引入变量/绑定 Preview → Apply 两阶段流程。
- 增加 Contract 校验与 AI 自动修复基础链路。
