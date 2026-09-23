(function (global) {
  'use strict';
  var PANE_STORAGE_KEY = 'report_assistant_workspace_v1';
  var ribbonUI = global.__RA_RibbonUI || null;

  function getUrlPath() {
    var url = decodeURI(document.location.toString());
    return url.split(/[?#]/)[0].slice(0, url.split(/[?#]/)[0].lastIndexOf('/'));
  }
  function getApp() {
    try { if (global.Application) return global.Application; } catch (_) {}
    try {
      if (global.wps) {
        for (var method of ['WpsApplication', 'EtApplication', 'WppApplication'])
          if (typeof global.wps[method] === 'function') return global.wps[method]();
        if (global.wps.Application) return global.wps.Application;
      }
    } catch (_) {}
    return null;
  }
  function taskPaneHost(app) {
    if (app && (app.CreateTaskPane || app.CreateTaskpane)) return app;
    if (global.wps && (global.wps.CreateTaskPane || global.wps.CreateTaskpane)) return global.wps;
    return null;
  }
  function getPane(host, id) {
    if (!id) return null;
    try { return host.GetTaskPane ? host.GetTaskPane(id) : host.GetTaskpane(id); } catch (_) { return null; }
  }
  function openAssistant() {
    try {
      var app = getApp(), host = taskPaneHost(app);
      if (!host) throw new Error('当前 WPS 版本没有提供任务窗格接口');
      var storage = app && app.PluginStorage;
      var paneId = storage && storage.getItem(PANE_STORAGE_KEY), pane = getPane(host, paneId);
      if (!pane) {
        var base = getUrlPath(), kind = base.slice(base.lastIndexOf('/') + 1);
        var url = base.slice(0, base.lastIndexOf('/')) + '/workspace/taskpane.html?host=' + encodeURIComponent(kind);
        pane = host.CreateTaskPane ? host.CreateTaskPane(url, '数据报告助手') : host.CreateTaskpane(url, '数据报告助手');
        if (!pane) throw new Error('WPS 未能创建任务窗格');
        try { if (storage && pane.ID != null) storage.setItem(PANE_STORAGE_KEY, String(pane.ID)); } catch (_) {}
      }
      try {
        var enums = app && app.Enum || host.Enum || global.wps && global.wps.Enum || {};
        pane.DockPosition = enums.JSKsoEnum_msoCTPDockPositionRight ?? enums.msoCTPDockPositionRight ?? 2;
        if (!Number(pane.Width || 0)) pane.Width = 360;
      } catch (_) {}
      pane.Visible = true;
      return true;
    } catch (error) {
      try { alert('打开数据报告助手失败：' + (error.message || String(error))); } catch (_) {}
      return false;
    }
  }

  global.__RA_OnAddinLoad = function (ui) { ribbonUI = ui || ribbonUI; global.__RA_RibbonUI = ribbonUI; return true; };
  global.__RA_OnGetEnabled = function () { return true; };
  global.__RA_OnAction = openAssistant;
  global.OnAddinLoad = global.__RA_OnAddinLoad;
  global.OnGetEnabled = global.__RA_OnGetEnabled;
  global.OnAction = global.__RA_OnAction;
  global.ReportAssistantOpen = openAssistant;
  if (global.__RA_PendingOpen) { global.__RA_PendingOpen = false; setTimeout(openAssistant, 0); }
})(window);
