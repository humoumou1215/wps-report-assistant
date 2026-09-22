# Pi Agent Host 迁移审核与实施记录

原始需求见 [PI_AGENT_SPEC.md](PI_AGENT_SPEC.md)。本文件记录可核实证据，不把尚未完成的检查当作已完成。

## 审核结论与方案调整

- 保留 spec 的主架构：Node 唯一写入者、每个 Variable 一个长期 Pi Session、Domain Tools 白名单、QuickJS 独立子进程、预览确认后提交。
- Source/Variable/记忆确认采用同一次 `state.json` 原子替换。已确认记忆的结构化数据和 revision anchor 先提交，`memory.md` 是可重建的语义视图，启动时重新生成，避免状态成功但 Markdown 写入中断后丢记忆。Session 不承担状态数据库作用。
- 项目写事务目前采用全局串行队列。这比每个项目一个锁更保守，可避免共享 `state.json` 的并发覆盖；Agent 推理及沙箱仍可并行，默认最多两个 Agent。
- 保留现有 prepared → applied → undoing → undone 日志。跨进程 WPS 写入不能假装是数据库事务；中断后的恢复必须有 Before/After 快照证据。
- 旧 DSL 仅由兼容解释器读取执行，新生成只允许 JavaScript 完整函数。保留 `core-go` 对照，禁止在真实双平台 WPS 验收之前删除。
- 安装包携带固定 Node 22.19.0，校验官方 SHA-256；携带 npm 锁文件对应的生产依赖，不要求最终用户安装开发工具。

## 已具备的实现及证据

| 范围 | 实现 | 当前验证 |
|---|---|---|
| TS 合同、Store | `shared/contracts`、`project/store.ts` | 草稿提交/取消、版本冲突、崩溃标记、原子替换及 fsync |
| Pi 隔离与会话 | `agent/pi-runtime.ts`、`session-registry.ts` | 真正 Pi 0.86.0 SDK + 本地 OpenAI 流式服务测试；恢复同一 JSONL；不加载用户 AGENTS/扩展 |
| 代码安全 | `sandbox/*` | 完整 renderer 回归、箭头/函数体、缺字段、无 Node/网络/时钟、超时后继续工作、结果大小 |
| Domain Tools | `agent/runtime.ts` | 执行后才能预览、结构化失败后修复、schema 错误强制再次 inspect、结果摘要 |
| 语义复核 | `agent/critic.ts` | 与 Generator Session 分离；两次修复上限及风险确认回归通过 |
| Binding 与文档日志 | `project/changes.ts` | stale target、连续 Apply/Undo、单调 revision、重启恢复、绑定范围记忆隔离 |
| Source 刷新 | `project/operations.ts` | 失败不改旧数据、不产生 AI Turn |
| HTTP/密钥 | `server/http-server.ts`、`model/settings.ts` | token、恶意 Origin、密钥独立存储与 GET 不回传 |
| WPS 适配器 | `addins/workspace` | 原有宿主模拟测试；整列 UsedRange 相交和刷新增长新增回归 |
| 安装包 | `scripts/package-agent-host.mjs`、installer/build 脚本 | 内置 Node 22.19.0 已运行测试；生产包可加载 Pi；完整 macOS payload 可 Go embed 编译；Windows installer 交叉编译通过 |

## Spec 完成对照

| Spec 章节 | 当前落点与证据 |
|---|---|
| 0–3 架构、依赖与 Pi 边界 | `agent-host/package-lock.json` 固定 Pi 0.86.0；`pi-runtime.ts` 显式业务工具、零外部资源发现；真正 SDK 测试注入恶意 AGENTS/扩展但不加载 |
| 4–8 Session 与 Source/Binding | 草稿即建立原生 UUID JSONL；Store 保持变量映射；刷新失败原子回滚；Binding 共用 Session 但按 ID 注入上下文 |
| 9–13 语义记忆 | pending delta 仅确认时提交；`memory.md` 从 Store 重建，按 Binding 分区；取消不提交，撤销恢复该 Binding 的规则；系统级经验不写入变量记忆 |
| 14–18 新鲜上下文、脚本合同 | Domain Tools 每次读 Store；脚本规范化；完整 transform/render、箭头和函数体回归通过；实际 SDK tool_call 能执行失败后修复 |
| 19–20 Sandbox | 独立 QuickJS WASM 进程，64MB、1.5s/5s、5MB/2MB、5000行/200列/2000格；无 Node/网络/时钟/随机/异步；超时后 Host 继续工作 |
| 21–27 工具、循环、Critic、Result | 十个 Domain Tools；最多5次执行/8轮模型/2次语义修复；独立无会话 Critic；完整结果在 Result Store，模型只见有界摘要；5000行真实工具循环验证未泄露完整结果 |
| 28–29 Compaction 与树 | Pi 原生 compact，产品固定语义提示；保留原始树 entries；变量 revision 保存 sessionEntryId；SDK compaction 测试验证提示与历史 |
| 30–32 Store/并发 | 单写者目录锁、原子替换/fsync、全局写队列；同变量互斥/全局2并发；超时和取消释放槽位；并发设置写入也串行 |
| 33 整行/整列 | `hosts.js` 解析 requested/effective range 并与 UsedRange 相交；新增801行回归通过；真实 WPS API 待人工验收 |
| 34–37 Provider/密钥/HTTP | 产品独立 ModelRuntime、thinking/compat/temperature；密钥分离且不回传；127.0.0.1、Host/Origin/token 校验；生产包 Node 固定版本 |
| 38–41 无副作用生成/写事务/冲突 | Agent 工具不改 WPS；确认后才写入；Before/After + prepared 日志；fingerprint、Source/Variable/Binding revision 在提交复查；连续撤销测试修复了历史对象引用共享问题 |
| 42–44 Run/SSE/诊断 | 持久化阶段事件、取消/超时/中断；认证 fetch SSE，重连和轮询兜底；诊断含结构化摘要，业务数据显式勾选才导出 |
| 45–47 模块/共享合同/错误 | `agent-host/src` 按 agent/model/project/sandbox/legacy/server 分层；`shared/contracts` 被 Host 与适配器类型引用；工具统一结构化错误 |
| 48–49 旧项目迁移 | Legacy DSL、动态程序与旧 JS 执行兼容，含空表/重复表头/空表头/别名/分组/格式；12个用例与真实 Go 执行器差分对照；迁移保留旧数据与备份 |
| 50–51 Installer | macOS LaunchAgent 与 Windows 隐藏启动切换到内置 Node；SHA-256 下载校验、锁定生产依赖、携带许可证；构建入口强制运行新旧回归 |
| 52–53 崩溃与记忆恢复 | 原生 Session 初始 header 持久化；启动将运行中任务标为 interrupted；工作台继续/预览/取消；当前状态优先于旧记忆锚点 |
| 54–55 回归要求 | Agent Host 41项测试（含差分子用例）；覆盖 A–H：完整renderer、语法修复、schema重查、会话复用、记忆、新revision、绑定隔离、大Source；前端18项 |
| 56–57 WPS验收/删除条件 | 按用户指示留给真实 WPS 执行，见验收清单；因此保留 `core-go`，不满足删除条件前不移除 |
| 58–61 实施与最终链路 | 新生成→执行→复核→预览→确认→Store/WPS，浏览器模拟跑通创建、输出、撤销、刷新恢复和取消；以此为新运行主链路 |

## 验证范围与保留边界

本地自动回归与模拟宿主证明代码链路，不证明真实 WPS 的 COM/JSAPI、字体、表格或注册行为。外部模型网关通过 OpenAI-compatible 接口接入；本地 SDK 回归使用脚本化 HTTP/SSE 模型，因此也不声称已逐一连接所有厂商的在线模型。

Ego Browser 使用同一 TaskSpace 3 的 ET 模拟页面验证了创建项目、生成/保存变量、输出预览/应用、历史撤销、页面刷新恢复未确认预览与取消；设置页密钥不回填另有 HTTP 与浏览器检查。测试宿主不进入生产安装包。

结果文件24小时后清理，仅清理未被活动草稿引用的结果。生成历史与已确认项目数据保留。异常损坏或不完整的 Host 锁采取拒绝启动，避免误判后双写；错误提示指向检查数据目录，不能强行覆盖状态。

安装包构建与固定 Node 运行结果见本次提交对应的本地命令记录。安装、升级、登录启动、卸载和真实 WPS 表现需按 [用户验收清单](PI_AGENT_WPS_ACCEPTANCE.md) 执行。此前根目录旧版验证文档是历史参考，本文件及新版清单优先。

## 本地开发验证

```sh
cd agent-host
npm ci
npm test
# 用隔离数据目录运行，避免修改用户真实数据
REPORT_ASSISTANT_DATA_DIR=/tmp/ra-development npm start
```

仓库根目录还应运行：`node --test tests/*.test.cjs`，`core-go` 和 `installer` 目录的 `go test ./...`、`go vet ./...`。

打包：`node scripts/package-agent-host.mjs OUTPUT darwin arm64`。开发构建机需 Node/npm；最终用户只使用 Installer。
