# Changelog

## 0.6.0-rc1

- 将 0.5.6 Core 能力重新合并进 0.4.2 的完整 ET/WPP/Installer 工程，恢复为可安装、可操作的完整插件。
- 新增变量与绑定 `Preview → Apply` 两阶段工作流；预览阶段不写项目、不修改 PPT。
- 新增 Transform/Renderer 契约校验：真实字段、步骤顺序、变量类型、目标类型、valuePath、表格列等在执行前校验。
- AI 输出失败时把确定性校验错误反馈给模型，最多自动修复 2 次（总计最多 3 次尝试）。
- 修复无 AI 时“状态=正式 + 预算金额合计”兜底规则选错聚合字段的问题。
- 用户明确指定亿元/万元/千元/百万元与小数位时，确定性语义覆盖冲突的 AI 格式参数。
- Source + Variable 确认时原子提交；PPT 本地 Apply 失败时尝试回滚刚创建的 Binding。
- 安装器现在真正写入 `core.log`，便于排查 Core 启动/运行失败。
- 增加 Preview/Apply、AI 自动修复、单位冲突等回归测试。

## 0.4.2

- 修复 AI 返回 `{renderer:{...}}` 时 Core 报“不支持的 renderer”。
- Renderer 增加兼容规范化与启动迁移。
- 支持文本数值 `divideBy` 单位换算，Case A 的 66,600,000 元可正确渲染为 0.67亿元。
- 对亿元、万元、千元、百万元描述增加确定性单位换算提示。
- RenderPlan 校验提前到 Binding 入库前，避免失败操作留下无效绑定。
- 新增第二份诊断包对应的精确回归测试。

## 0.4.1

- 修复 TransformSpec 中 `type/op` 与 canonical `op/operator|fn` 契约差异。
- 增加规则规范化与兼容执行。
