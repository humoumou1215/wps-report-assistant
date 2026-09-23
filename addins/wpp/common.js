(function (global) {
  'use strict';
  var CORE = global.location && global.location.protocol === 'http:' && global.location.hostname === '127.0.0.1'
    ? global.location.origin
    : 'http://127.0.0.1:17891';
  var sessionToken = '';
  function $(selector) { return document.querySelector(selector); }
  function $$(selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }
  function toast(message, kind) {
    var element = $('#toast');
    if (!element) return;
    element.textContent = message;
    element.className = (kind === 'err' ? 'err ' : '') + 'show';
    clearTimeout(element.__timer);
    element.__timer = setTimeout(function () { element.className = ''; }, 4200);
  }
  async function api(path, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    if (sessionToken) headers['X-RA-Token'] = sessionToken;
    var request = { method: options.method || 'GET', headers: headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      request.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }
    var response = await fetch(CORE + path, request), data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) {
      var error = new Error(data.error || ('HTTP ' + response.status));
      error.code = data.code;
      throw error;
    }
    return data;
  }
  function subscribe(path, onEvent) {
    var controller = new AbortController(), stopped = false, delay = 1000;
    function pause(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
    function dispatch(block) {
      var eventName = 'message', data = [];
      block.split(/\r?\n/).forEach(function (line) {
        if (!line || line.charAt(0) === ':') return;
        var colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon), value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') eventName = value;
        else if (field === 'data') data.push(value);
      });
      if (!data.length) return;
      try { onEvent(eventName, JSON.parse(data.join('\n'))); } catch (_) {}
    }
    async function connect() {
      while (!stopped) {
        try {
          var response = await fetch(CORE + path, { headers: { 'Accept': 'text/event-stream', 'X-RA-Token': sessionToken }, signal: controller.signal });
          if (!response.ok || !response.body) throw new Error('实时事件连接失败：HTTP ' + response.status);
          delay = 1000;
          var reader = response.body.getReader(), decoder = new TextDecoder(), buffer = '';
          while (!stopped) {
            var chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            var parts = buffer.split(/\r?\n\r?\n/); buffer = parts.pop() || '';
            parts.forEach(dispatch);
          }
        } catch (error) {
          if (stopped || error && error.name === 'AbortError') break;
          if (error && /401/.test(error.message || '')) await checkCore().catch(function () {});
        }
        if (!stopped) { await pause(delay); delay = Math.min(delay * 2, 15000); }
      }
    }
    connect();
    return { close: function () { stopped = true; controller.abort(); } };
  }
  function previewValue(variable) {
    if (!variable) return '<div class="empty">无结果</div>';
    if (variable.valueType === 'table') {
      var rows = Array.isArray(variable.value) ? variable.value : [], columns = variable.columns || [];
      return '<div class="tablewrap"><table><thead><tr>' + columns.map(function (column) {
        return '<th>' + esc(column) + '</th>';
      }).join('') + '</tr></thead><tbody>' + rows.slice(0, 20).map(function (row) {
        return '<tr>' + columns.map(function (column) { return '<td>' + esc(row && row[column]) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div><div class="muted">' + rows.length + ' 行' + (rows.length > 20 ? '（预览前20行）' : '') + '</div>';
    }
    return '<div class="mono">' + esc(variable.value) + '</div>';
  }
  async function checkCore() {
    var dot = $('#coreDot'), label = $('#coreState');
    try {
      var health = await api('/api/health');
      sessionToken = health.token || '';
      if (dot) { dot.classList.add('ok'); dot.classList.remove('bad'); }
      if (label) label.textContent = '服务 ' + health.version + ' 已连接';
      return true;
    } catch (_) {
      if (dot) { dot.classList.add('bad'); dot.classList.remove('ok'); }
      if (label) label.textContent = '本地服务未启动';
      return false;
    }
  }
  async function loadSettings() {
    var settings = await api('/api/settings'), ai = settings.ai || {}, automation = settings.automation || {}, ui = settings.ui || {};
    if ($('#aiEnabled')) $('#aiEnabled').checked = !!ai.enabled;
    if ($('#aiBaseUrl')) $('#aiBaseUrl').value = ai.baseUrl || '';
    if ($('#aiModel')) $('#aiModel').value = ai.model || '';
    if ($('#aiKey')) {
      $('#aiKey').value = '';
      $('#aiKey').placeholder = ai.apiKeyConfigured ? '已配置，留空保留现有密钥' : '请输入 API Key';
    }
    if ($('#renderExecutionMode')) $('#renderExecutionMode').value = automation.renderExecutionMode || 'auto-reversible';
    if ($('#autoRefreshVariables')) $('#autoRefreshVariables').checked = automation.autoRefreshVariables !== false;
    if ($('#timelineScope')) $('#timelineScope').value = ui.timelineScope || 'current-document';
    if ($('#liveVariableStatus')) $('#liveVariableStatus').checked = ui.liveVariableStatus !== false;
    return settings;
  }
  async function saveSettings() {
    var apiKey = $('#aiKey').value.trim();
    var settings = {
      ai: {
        enabled: $('#aiEnabled').checked,
        baseUrl: $('#aiBaseUrl').value.trim(),
        model: $('#aiModel').value.trim()
      },
      automation: {
        renderExecutionMode: $('#renderExecutionMode').value,
        autoRefreshVariables: $('#autoRefreshVariables').checked
      },
      ui: {
        timelineScope: $('#timelineScope').value,
        liveVariableStatus: $('#liveVariableStatus').checked
      }
    };
    if (apiKey) settings.ai.apiKey = apiKey;
    await api('/api/settings', { method: 'POST', body: settings });
    var saved = await loadSettings();
    if (global.RAWorkspace && global.RAWorkspace.applySettings) global.RAWorkspace.applySettings(saved);
    if (global.RAConversation && global.RAConversation.refreshTimeline) global.RAConversation.refreshTimeline().catch(function () {});
    toast('设置已保存');
  }
  function wireSettings() {
    var save = $('#saveSettings');
    if (save) save.onclick = function () { saveSettings().catch(function (error) { toast(error.message, 'err'); }); };
  }
  function renderFiles(project) {
    var box = $('#projectFiles');
    if (!box) return;
    var documents = project && project.documents || [];
    box.innerHTML = documents.length ? documents.map(function (document) {
      return '<div class="file"><span class="file-kind">' + esc(({ et: '表格', wpp: '演示', wps: '文字' })[document.kind] || '文件') + '</span><span title="' + esc(document.key) + '">' + esc(document.name || document.key) + '</span></div>';
    }).join('') : '<div class="muted">项目中还没有文件</div>';
  }
  global.RA = { CORE: CORE, $: $, $$: $$, esc: esc, toast: toast, api: api, subscribe: subscribe, previewValue: previewValue, checkCore: checkCore, loadSettings: loadSettings, wireSettings: wireSettings, renderFiles: renderFiles };
})(window);
