(function (global) {
  'use strict';
  var PANE_STORAGE_KEY = 'report_assistant_taskpane_v03';
  var ribbonUI = global.__RA_RibbonUI || null;

  function getUrlPath() {
    var url = decodeURI(document.location.toString());
    var q = url.indexOf('?');
    if (q >= 0) url = url.slice(0, q);
    var h = url.indexOf('#');
    if (h >= 0) url = url.slice(0, h);
    return url.substring(0, url.lastIndexOf('/'));
  }

  function getApp() {
    try { if (global.Application) return global.Application; } catch (e) {}
    try { if (global.wps && typeof global.wps.EtApplication === 'function') return global.wps.EtApplication(); } catch (e) {}
    try { if (global.wps && typeof global.wps.WppApplication === 'function') return global.wps.WppApplication(); } catch (e) {}
    try { if (global.wps && global.wps.Application) return global.wps.Application; } catch (e) {}
    return null;
  }

  function getPaneHost(app) {
    if (app && (typeof app.CreateTaskPane === 'function' || typeof app.CreateTaskpane === 'function')) return app;
    if (global.wps && (typeof global.wps.CreateTaskPane === 'function' || typeof global.wps.CreateTaskpane === 'function')) return global.wps;
    return null;
  }

  function createPane(host, url) {
    if (typeof host.CreateTaskPane === 'function') return host.CreateTaskPane(url, '数据报告助手');
    if (typeof host.CreateTaskpane === 'function') return host.CreateTaskpane(url, '数据报告助手');
    return null;
  }

  function getPane(host, id) {
    if (!id) return null;
    try {
      if (typeof host.GetTaskPane === 'function') return host.GetTaskPane(id);
      if (typeof host.GetTaskpane === 'function') return host.GetTaskpane(id);
    } catch (e) {}
    return null;
  }

  function readStoredId(app) {
    try { return app && app.PluginStorage && app.PluginStorage.getItem(PANE_STORAGE_KEY); } catch (e) { return null; }
  }

  function writeStoredId(app, id) {
    try { if (app && app.PluginStorage && id != null) app.PluginStorage.setItem(PANE_STORAGE_KEY, String(id)); } catch (e) {}
  }

  function configurePane(pane, app, host) {
    try {
      var enumHost = (app && app.Enum) || (host && host.Enum) || (global.wps && global.wps.Enum);
      if (enumHost && enumHost.JSKsoEnum_msoCTPDockPositionRight !== undefined) {
        pane.DockPosition = enumHost.JSKsoEnum_msoCTPDockPositionRight;
      } else if (enumHost && enumHost.msoCTPDockPositionRight !== undefined) {
        pane.DockPosition = enumHost.msoCTPDockPositionRight;
      } else {
        pane.DockPosition = 2;
      }
    } catch (e) {}
    try { pane.Width = 430; } catch (e) {}
    pane.Visible = true;
  }

  function showReportAssistant() {
    try {
      var app = getApp();
      var host = getPaneHost(app);
      if (!host) throw new Error('当前 WPS 版本没有提供 CreateTaskPane 接口');

      var pane = getPane(host, readStoredId(app));
      if (!pane) {
        var url = getUrlPath() + '/taskpane.html';
        pane = createPane(host, url);
        if (!pane) throw new Error('CreateTaskPane 返回空对象，请确认 WPS 已允许加载项页面');
        try { writeStoredId(app, pane.ID); } catch (e) {}
      }
      configurePane(pane, app, host);
      return true;
    } catch (e) {
      try { alert('打开数据报告助手失败：' + (e && e.message ? e.message : String(e)) + '\n\n请不要在浏览器里操作；助手应显示在 WPS 右侧任务窗格。'); } catch (_) {}
      return false;
    }
  }

  global.__RA_OnAddinLoad = function (ui) {
    ribbonUI = ui || ribbonUI;
    global.__RA_RibbonUI = ribbonUI;
    return true;
  };
  global.__RA_OnGetEnabled = function () { return true; };
  global.__RA_OnAction = function () { return showReportAssistant(); };

  global.OnAddinLoad = global.__RA_OnAddinLoad;
  global.OnGetEnabled = global.__RA_OnGetEnabled;
  global.OnAction = global.__RA_OnAction;
  global.ReportAssistantOpen = showReportAssistant;

  if (global.__RA_PendingOpen) {
    global.__RA_PendingOpen = false;
    setTimeout(showReportAssistant, 0);
  }
})(window);
