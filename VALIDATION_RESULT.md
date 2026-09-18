# v0.6.0-rc1 开发侧验证结果

## 已通过

- Core：`go test -race ./...`
- Core：`go vet ./...`
- Installer helpers：`go test ./...`、`go vet ./...`
- ET/WPP：`node --check`（taskpane.js / common.js）
- AI 自动修复回归：
  - 引用不存在字段 → 返回确定性错误 → AI 第二次修复成功。
  - 引用存在但业务字段错误（实际金额 vs 预算金额合计）→ 显式意图校验拦截 → AI 修复成功。
  - 文本 Renderer valuePath 不存在 → AI 修复成功。
  - AI 返回错误单位参数 → 用户明确的亿元/万元与小数位确定性覆盖。
  - 表格“金额按万元显示”会校正金额列，不会无条件缩放人数等无关列。
- Preview/Apply 回归：
  - Variable preview 前项目不新增 Source / Variable。
  - Variable apply 一次提交 Source + Variable。
  - Binding preview 前项目不新增 Binding。
  - Binding apply 后才持久化 Binding。
- 最终 Core HTTP 冒烟：
  - 健康检查版本：`0.6.0-rc1`。
  - ET/WPP 最终任务窗格可以由 Core 静态服务访问。
  - 标准 Case A：66,600,000 → `0.67亿元`。
  - 最终计数：1 Source / 1 Variable / 1 Binding。
- Windows amd64 交付物已成功交叉编译，Core 与 Setup 均确认为 `PE32+ GUI x86-64`。
- 最终 Setup 已重新嵌入本轮生成的 Core、ET/WPP、samples 和验证文档，并检查到新 `/variables/preview`、`/bindings/preview` 前端调用。

## 仍需要用户在 Windows + WPS 实机确认

当前执行环境不是 Windows/WPS，因此以下部分无法在开发容器里真实调用 WPS COM/JS 宿主，只能由最终用户验收：

1. Setup 对本机 `publish.xml` 的真实合并效果与 WPS 重启后的 Ribbon/任务窗格加载。
2. WPS 表格对象模型读取真实选区。
3. WPS 演示对象模型定位真实 Shape、修改文本框、增删表格行。
4. 用户自己的 OpenAI-compatible 模型端点、鉴权与模型行为。

这些项目都已在 `VALIDATION_GUIDE.md` 中给出固定 Case 与预期值。若失败，请直接导出诊断 ZIP 返回。
