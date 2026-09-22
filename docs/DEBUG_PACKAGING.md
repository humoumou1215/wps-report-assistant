# 调试分包发布流程

发布构建同时保留全量安装包和调试分包。调试分包的固定目录是 `dist/debug-windows-x64/` 或 `dist/debug-macos-arm64/`。

每次执行正常打包命令时，`scripts/package-debug-update.py` 会：

- 生成或复用 `DataReportAssistant-Debug-Base-<target>.zip`。它只包含内置 Node Runtime 等固定依赖；固定依赖未变化时不会重传、重建。
- 生成 `DataReportAssistant-Debug-Update-<version>-<target>.zip`。首次构建包含全部可变文件，后续只包含相对上次构建发生变化的文件，并记录删除列表。
- 保存上一版文件哈希到 `dist/debug-<target>/last-update-manifest.json`。该目录不要在连续调试构建之间清理，否则下一包会重新成为完整增量包。
- 输出 `Apply-DebugPackage.ps1` 和 `DEBUG_PACKAGE_INDEX.json`，便于 Windows 调试机应用和核对包的基线。

Windows 调试机首次使用时先应用固定依赖包，再应用对应的增量包：

```powershell
powershell -ExecutionPolicy Bypass -File .\Apply-DebugPackage.ps1 `
  -Package .\DataReportAssistant-Debug-Base-windows-x64.zip

powershell -ExecutionPolicy Bypass -File .\Apply-DebugPackage.ps1 `
  -Package .\DataReportAssistant-Debug-Update-1.0.8-pi-windows-x64.zip
```

后续每次只应用新的 `Debug-Update` 包，不能跳过中间包；脚本会校验固定依赖基线、增量文件 SHA-256、当前 `fromVersion`，停止并重新启动安装目录对应的 Node Agent，等待 `/api/health` 返回目标版本后才报告成功。固定依赖、版本顺序或 Agent 启动校验不匹配时会拒绝更新。完整 `DataReportAssistant-Setup-<version>.exe` 和完整 ZIP 仍由原流程照常产出，适合新用户或需要完整安装注册信息的场景。
