# 数据报告助手 v1.0.8-pi

WPS 表格、文字、演示共用的本地数据工作区。AI 编写计算和展示脚本，独立沙箱使用完整数据执行；用户预览并确认后，插件才保存变量或修改文档。

本版将运行核心迁移为 TypeScript Agent Host，使用固定 Pi 0.86.0 和安装包内置的 Node 22.19.0。最终用户无需安装 Node、npm 或 Go。

## 使用流程

1. 退出 WPS，运行对应平台的安装器，再重新打开 WPS。
2. 在侧栏设置中填写 OpenAI-compatible Base URL、模型和 API Key。
3. 从选区提取数据，描述计算要求，检查实际执行结果后保存变量。
4. 选择目标区域或对象，描述展示要求，预览后应用。
5. 在“修改历史”中检查前后内容和撤销。未确认的生成任务可在重启后继续查看或取消。

独立语义复核始终启用。复核最多触发两次修复，仍未通过的结果必须明确确认风险才能应用。模型不可用时，新生成会显示错误；已保存的脚本仍可用于确定性刷新。

**真实 WPS 与安装升级仍需人工验收。** 请执行 [新版验收清单](docs/PI_AGENT_WPS_ACCEPTANCE.md)，不要把模拟宿主测试等同于 WPS 实测。实现审查与自动验证范围见 [实施记录](docs/PI_AGENT_IMPLEMENTATION.md)。

## 架构与边界

- 每个变量从草稿起拥有稳定的 Pi Session UUID，后续变量修改及其输出绑定复用此会话。
- Project Store 是当前业务事实；Session 保存历史，`memory.md` 保存确认后的语义决定。取消预览不会提交记忆。
- Agent 只有显式业务工具，无文件、Shell、网络搜索或 WPS 写入工具。每轮注入最新状态和受限摘要。
- 新 Transform/Renderer 使用完整 JavaScript 函数，通过独立进程中的 QuickJS WASM 执行。脚本不能访问 Node、网络、文件或 WPS；结果、时长和内存均有限制。
- WPS 写入保留 prepared/applied/undoing/undone 日志和 Before/After 快照；提交前检查数据版本和目标是否变化。
- 本地服务只监听 `127.0.0.1:17891`，业务 API 校验 token 与 Origin。API Key 分离存储，设置读取只返回是否已配置。

旧 DSL、动态能力和旧 JavaScript 通过兼容执行器读取运行，新生成不再产生 DSL。`core-go` 保留为迁移对照，不随新安装包作为业务服务运行；真实双平台 WPS 验收完成前不删除。

### 模块职责

- `addins/workspace/` 只负责 WPS 适配器、选区／目标快照、预览确认和实际写入；不保存业务真相，也不让 AI 直接调用 WPS API。
- `agent-host/src/server/` 负责本地 HTTP/SSE、认证和路由；`agent-host/src/agent/` 负责 Agent 回合、Domain Tool 白名单、候选生命周期与语义复核。
- `agent-host/src/project/` 是唯一业务状态写入边界，维护 Project/Source/Variable/Binding、版本冲突、记忆和可恢复修改日志；`agent-host/src/model/` 只负责模型配置、密钥隔离和 Provider。
- `agent-host/src/sandbox/` 在独立 QuickJS 进程中执行候选脚本并做结构/容量校验；`agent-host/src/legacy/` 只兼容旧项目，不参与新候选生成。
- `shared/contracts/` 保存 Host 与前端共用的数据合同；`installer/` 负责安装、启动和注册，`scripts/` 负责版本校验、Agent Host 打包和 Base/Update 调试分包；`core-go/` 仅作迁移对照，不能与新 Host 共同写同一数据目录。

Agent Domain Tool 的对象范围由当前任务上下文隐式绑定，模型只提交查询参数、候选代码和记忆内容；Project/Source/Variable/Binding ID 由 Host 内部校验，避免把模型重复传递的 ID 误当成跨对象访问。

## 开发与验证

构建机需要 Node/npm 和 Go。使用锁文件安装依赖：

```sh
cd agent-host
npm ci
npm test
REPORT_ASSISTANT_DATA_DIR=/tmp/ra-development npm start
```

请使用隔离数据目录开发。现有数据迁移前会保存一次状态备份；不要让新旧服务同时写同一目录。

其他回归：

```sh
node --test tests/*.test.cjs
(cd core-go && go test ./... && go vet ./...)
(cd installer && go test ./... && go vet ./...)
```

发布构建会运行回归、校验官方 Node 下载的 SHA-256，并打包锁定的生产依赖：

```sh
bash build-macos.sh arm64   # Intel 使用 amd64
python3 build-windows.py   # 交叉构建 Windows x64 ZIP
# Windows 本机：powershell -File build-release.ps1
# 一台构建机同时生成 Windows x64 和 macOS arm64：
python3 scripts/build-release.py all
```

输出位于 `dist/`。除全量安装包外，构建还会在 `dist/debug-windows-x64/` 或 `dist/debug-macos-arm64/` 生成固定依赖包和调试增量包；固定依赖不变时，后续增量包不会重复携带 Runtime。具体应用方式见 [调试分包发布流程](docs/DEBUG_PACKAGING.md)。安装器代码仍使用 Go，业务执行由内置 Node 启动。

目录：`agent-host/` 为服务、Agent、沙箱与测试，`shared/contracts/` 为共享合同，`addins/workspace/` 为 WPS 工作台，`installer/` 和 `scripts/` 为安装与打包。

其他资料：[原始架构 spec](docs/PI_AGENT_SPEC.md)、[宿主扩展接口](HOST_CAPABILITIES.md)、[文档修改与撤销](CHANGE_HISTORY.md)。旧版验证文档用于历史参考，新版以 `docs/PI_AGENT_*` 为准。
