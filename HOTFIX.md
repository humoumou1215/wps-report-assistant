# v0.4.2 Hotfix 说明

本版本修复第二份诊断包暴露的 PPT Renderer 契约问题。

## 根因

AI 实际返回：

```json
{
  "renderer": {
    "kind": "text",
    "valuePath": "$",
    "template": "{{value}}",
    "format": {"numberFormat":"0.00","suffix":"亿元"}
  }
}
```

而 Core 原先直接把整个对象当成 renderer，因此读取不到顶层 `kind`，最终在 `render-plan` 阶段报错：`不支持的 renderer`。

同时还有一个隐藏问题：用户要求“按亿元显示”时，只追加 `亿元` 后缀并不等于完成单位换算。66,600,000 元应先除以 100,000,000，再按两位小数显示为 `0.67亿元`。

## 修复

- Renderer 接受 canonical 对象与 `{renderer:{...}}` 两种 AI 返回形态，并统一规范化。
- 文本 Renderer 新增 `format.divideBy`；万元/亿元等单位换算可确定性执行。
- 对“按亿元/万元/千元/百万元显示”等描述增加确定性提示补全，避免 AI 只加单位不换算。
- `RenderPlan` 自身再次规范化 Renderer，兼容已经保存的旧绑定。
- Core 启动时迁移 v0.4.1 已保存的嵌套 Renderer，并根据绑定描述恢复单位换算。
- 先生成并校验 RenderPlan，再持久化 Binding；无效 Renderer 不再留下坏绑定。
- 新增回归测试，直接使用本次诊断包里的 Renderer 形态，要求 Case A 输出严格为 `0.67亿元`。

## 升级

直接运行 `DataReportAssistant-Setup-0.4.2.exe` 覆盖安装即可。项目、变量、AI 设置与已有绑定都会保留；v0.4.1 的坏绑定会在 Core 启动时尝试自动修复。
