# 数据报告助手

WPS 表格、文字和演示共用的本地 AI 工作区。用户在会话中描述目标，助手读取当前项目的文件、选区和变量，在隔离沙箱中计算；所有文档写入只能经过 Render Gateway，并记录可验证、可撤销的 Before/After。

## 使用

1. 安装对应平台的完整安装包，重新打开 WPS。
2. 在“设置”中配置兼容 OpenAI API 的地址、模型和密钥。
3. 将当前文件加入项目，在“会话”里描述任务；用 `@` 引用文件、变量、选区或 Render 记录。
4. 在“变量”检查数据来源、计算说明和版本；从修改时间线查看写入、验证、撤销或恢复状态。

计算脚本不能访问文件、网络、进程或 WPS。语义复核始终启用；自动写入只允许可逆目标。真实 WPS 的 COM/JSAPI、格式还原和视觉排版仍需按[人工验收清单](docs/PI_AGENT_WPS_ACCEPTANCE.md)检查。

## 数据与安全

- 项目、会话、任务与变量解释保存在本机 Agent Host 数据目录；Pi Session 只保留对话历史，不作为实时业务事实。
- 当前 Store 格式为 version 3。旧格式不会迁移或被覆盖；遇到不匹配时服务会明确停止，需由用户选择新的空数据目录。
- API Key 单独保存在本机密钥文件；API 只返回是否已配置。服务仅绑定 `127.0.0.1`，业务请求校验本地令牌和来源。
- `RenderLedger` 为追加式记录。Undo 和中断恢复都会创建新记录；目标在预览后变化时拒绝覆盖。

## 开发与验证

需要 Node.js 22.19.0+、npm 和 Go（仅用于构建安装器）。

```sh
cd agent-host
npm ci
npm test
REPORT_ASSISTANT_DATA_DIR=/tmp/ra-development npm start
```

仓库回归：

```sh
node --test tests/*.test.cjs
(cd installer && go test ./... && go vet ./...)
node scripts/check-version.mjs
git diff --check
```

发布必须按 [AGENTS.md](AGENTS.md) 先更新根目录 `VERSION`，再经固定入口构建全量包和调试 Base/Update 分包。产物及复用规则见[调试分包说明](docs/DEBUG_PACKAGING.md)。

架构和主链路见[Conversation 与 Reversible Render](docs/CONVERSATION_RENDER_SPEC.md)。
