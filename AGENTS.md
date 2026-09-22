# Agent 打包规范

本项目的可分发构建必须同时提供全量安装包和调试分包。任何 Agent 修改了会进入安装包的代码、前端资源、Agent Host、Runtime 或文档后，都必须按本文件重新打包并验证；不得只手工压缩某个目录。

## 版本规则

- 当前版本唯一来源是根目录 `VERSION`。
- 生成任何可分发包前先递增 `VERSION`，再运行 `node scripts/check-version.mjs`。
- 禁止在打包脚本中重新写死版本号。安装器、Agent Host、健康检查、文档和清单中的版本必须由版本校验脚本统一确认。
- 当前版本不变的重复构建只能用于验证复用逻辑，不应作为新的对外发布版本。

## 固定打包入口

按目标平台执行以下命令之一；这些入口会自动运行测试、构建全量包，并调用 `scripts/package-debug-update.py` 生成调试分包：

```sh
# macOS Apple Silicon
bash build-macos.sh arm64

# macOS Intel
bash build-macos.sh amd64

# Windows x64 交叉构建
python3 build-windows.py

# Windows 本机 PowerShell 构建
powershell -File build-release.ps1
```

构建前必须保留 `dist/debug-<target>/` 中的以下状态文件，以便下一次只计算真正变化的文件：

- `last-fixed-manifest.json`
- `last-update-manifest.json`
- `DataReportAssistant-Debug-Base-<target>.zip`

如果主动删除这些文件，下一次调试增量包会退化为“首次增量包”，携带全部可变文件；这不是错误，但会增加一次传输量。

## 产物规则

每个目标都必须检查以下产物：

- 全量安装包：Windows `DataReportAssistant-Setup-<version>.exe` 及完整 ZIP；macOS `DataReportAssistantInstaller`。
- 固定依赖包：`DataReportAssistant-Debug-Base-<target>.zip`，只包含 `runtime/` 和 `FIXED_DEPENDENCIES.json`。固定依赖未变化时复用原包，不得重复传输。
- 调试增量包：`DataReportAssistant-Debug-Update-<version>-<target>.zip`，只包含变化文件、删除清单和 `DEBUG_UPDATE_MANIFEST.json`；不得包含 `runtime/`。
- Windows 应用脚本：`Apply-DebugPackage.ps1`。

全量包始终保留，供新机器安装或需要安装注册信息的用户自行选择。调试分包用于已有安装目录的快速更新，不得取代全量安装包。

## 调试分包应用顺序

Windows 调试机首次使用某个目标的分包时，先应用一次固定依赖包，再按版本顺序应用每个增量包：

```powershell
powershell -ExecutionPolicy Bypass -File .\Apply-DebugPackage.ps1 `
  -Package .\DataReportAssistant-Debug-Base-windows-x64.zip
powershell -ExecutionPolicy Bypass -File .\Apply-DebugPackage.ps1 `
  -Package .\DataReportAssistant-Debug-Update-<version>-windows-x64.zip
```

不得跳过中间增量包。应用脚本会校验固定依赖 ID、增量文件 SHA-256 和 `fromVersion`；校验失败时停止，不得强行覆盖。固定 Runtime 不得放进后续增量包。macOS 当前同样生成 Base/Update 清单，但本仓库提供的自动应用脚本是 Windows PowerShell 脚本。

## 最低验证清单

打包完成后至少执行：

```sh
node scripts/check-version.mjs
git diff --check
```

并确认：

1. 全量安装包存在且 ZIP 可测试解压。
2. 固定包清单中的文件与 ZIP 内容一致。
3. 增量包中不存在 `runtime/`，且 ZIP 文件集合与 `changed` 清单一致。
4. 重复执行同版本、无源码变化的构建时，固定包时间/大小保持不变，增量包 `changedFileCount` 为 `0` 或仅有构建元数据变化。
5. 发布前记录全量包、Base 包和 Update 包的 SHA-256；不要把 `dist/` 产物误当作源码修改提交。

详细应用说明见 `docs/DEBUG_PACKAGING.md`。`dist/debug-<target>/DEBUG_PACKAGE_INDEX.json` 是当前 Base ID、Update 文件名和变化数量的权威索引。
