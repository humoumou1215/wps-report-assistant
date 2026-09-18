# 安装方案设计（v0.3 引入，v0.4 延续）

## 目标

普通用户的安装行为收敛为：

1. 双击 Setup.exe。
2. 点击“是”。
3. 重启 WPS。

不再要求用户安装 Node.js、npm、wpsjs，不再要求打开 PowerShell，不再要求启动三个开发进程。

## 运行结构

```text
Windows 登录
    │
    └─ HKCU Run
         │
         ▼
DataReportAssistantCore.exe
  127.0.0.1:17891
    ├─ /api/*                 项目/变量/绑定/AI
    ├─ /addins/et/*           WPS 表格加载项资源
    └─ /addins/wpp/*          WPS 演示加载项资源

WPS publish.xml
    ├─ DataReportAssistantET  -> http://127.0.0.1:17891/addins/et/
    └─ DataReportAssistantWPP -> http://127.0.0.1:17891/addins/wpp/
```

## 为什么 v0.3 把 Node Core 改成 Go Core

v0.2 的业务设计没有问题，但 Node Core 会把 Node.js 变成最终用户的安装前置条件。如果把 Node Runtime 一并打包，安装包和运行结构仍然偏重。

v0.3 起保持原 API 和数据格式，重新实现为单一 Windows Core EXE；v0.4 继续沿用该结构，因此：

- 用户侧零运行时依赖；
- Core 无控制台窗口；
- 安装器可以直接管理 Core 生命周期；
- 后面做自动升级也更简单。

## WPS 插件注册策略

WPS 官方当前推荐 `publish.xml` 模式。安装器不会覆盖整个 `publish.xml`，只删除/更新本项目自己的条目，再把 ET/WPP 两条记录插回去；其他插件记录保持不变。

第一次修改前还会保存：

`publish.xml.backup-before-data-report-assistant`

这比让普通用户运行 `wpsjs debug` 更接近正式分发形态。

## 数据与程序分离

```text
%LOCALAPPDATA%\DataReportAssistant\
├─ app\        可随升级/卸载替换
└─ data\       项目数据，默认保留
```

这样升级程序不会动项目数据；卸载误操作也不会直接丢掉用户已经配置好的项目。

## 当前不做的事情

- 不修改 WPS 安装目录和 `oem.ini`。
- 不要求管理员权限。
- 不在局域网开放 17891 端口。
- 不使用 `jsplugins.xml` 二次打包模式。
- 不在安装阶段改变第 2 步的侧边栏交互。
