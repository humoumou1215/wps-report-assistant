# WPS 宿主能力扩展

输入、输出由能力决定，而不是扩展名。WPS 能打开文件并不意味着插件能修改所有对象：每种对象必须有读取、定位、写入及可验证的恢复实现。当前内置 ET 单元格、WPS 文字选区／已有表格、WPP 文本／已有表格。图片、图表、PDF 等需新增对应能力，不宣称已自动支持。

## 数据流

`宿主选区 → Source(values, capabilityId, locator) → Variable → RenderPlan → 宿主能力 → 原文件`

Source 和 Binding 都归属项目内的 Document；Document.kind 是可扩展宿主标识，不限制 et/wps/wpp。Core 不解析文件后缀。旧 ET Source 和 WPP Binding 保持兼容。

- 读取统一返回二维 values 和 headersMode，首行是列名。纯文字可转换为 `[["内容"], [选区文本]]`。
- 当前计算与展示引擎输出 text 或 table 计划。能力可把表格计划转换成图表等对象；若要新增计划类型，也需要扩展 Core 的计划验证与渲染执行器。
- 输出前先持久化可恢复快照，写入后记录实际快照。撤销前比较当前状态与历史，避免覆盖人工修改。未完成的写入会阻止同一文件继续写入，直到恢复处理。
- 历史沿用 state.json 的 pptChanges 字段以兼容旧项目，内容已可表示不同宿主。

## 注册接口

在 `addins/workspace/extensions.js` 中注册可信本地代码，不接收 AI 返回的任意宿主脚本。

```js
RAHosts.registerHost({
  id: 'custom', label: '自定义宿主',
  app: function () { return /* 宿主 API */; },
  document: function () {
    return { key: '/saved/file', name: '文件名', kind: 'custom', capabilities: ['custom.object'] };
  }
});
RAHosts.registerCapability({
  id: 'custom.object', host: 'custom', label: '对象',
  inputTypes: ['table'], outputTypes: ['text', 'table'],
  selection: function () { return { capabilityId: this.id, kind: 'text', locator: {id: '稳定标识'}, label: '用户可读位置' }; },
  read: function (locator) { return { values: [['内容'], ['读到的值']], headersMode: 'first-row', capabilityId: this.id, locator: locator }; },
  locate: function (locator) { return /* 当前文件中的对象 */; },
  snapshot: function (object, locator) { return /* 完整、可序列化、可恢复快照 */; },
  preflight: function (object, plan, locator) { /* 写入前检查支持范围；失败必须抛错 */ },
  apply: function (object, plan, locator) { /* 修改原文件 */ },
  restore: function (object, snapshot, locator) { /* 恢复内容与格式 */ }
});
```

快照至少包含 `version: 1`、`kind`、`adapterId`（等于 capabilityId）。现有 text/table 快照用于内容对比；其他对象使用 `summary` 提供用户可读摘要。可选 comparison 为稳定语义指纹，须包含所有将修改的内容和格式，不能通过忽略用户修改来规避冲突。原始快照仍保存完整恢复数据。

宿主入口通过 `workspace/taskpane.html?host=<id>` 进入同一工作区。新增 WPS 宿主类型还要注册相应 ribbon 与安装器入口。相同宿主的新能力直接出现在读取／写入方式中。

## 当前边界

- 表格：读取最多 5000 行；一次写入最多 2000 个单元格；不支持合并区域，不自动扩展选区。公式、值、数字格式和已支持的字体／对齐属性进入快照。
- 演示：文本和固定尺寸表格；不自动增删行。缺少必要格式 API、合并单元格或不支持的特殊格式时阻止写入。
- 文字：依赖 WordOpenXML、InsertXML 与书签 API；修订模式下拒绝写入；书签丢失且原选区变化时拒绝定位。真实 WPS 的 XML 恢复兼容性需要按验收清单确认。
- 跨文件操作要求用户在对应 WPS 文件中打开侧栏；插件不会在后台打开或保存用户文档。保存项目数据不会自动改写已绑定输出。

## 自动化验证

`node --test tests/*.test.cjs` 验证适配器和历史状态机。`core-go/portable_workspace_test.go` 验证四种宿主的 16 种方向组合、版本冲突与持久化。模拟宿主测试不能替代真实 WPS API 验收。
