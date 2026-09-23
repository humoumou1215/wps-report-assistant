(function () {
  'use strict';
  var $ = RA.$, $$ = RA.$$, api = RA.api, esc = RA.esc;
  var hostId = new URLSearchParams(location.search).get('host') || 'wps';
  var host = RAHosts.hosts[hostId];
  var state = { document: null, project: null, variable: null, liveVariableStatus: true, variableFilter: 'all' };

  function documentKey(document) {
    var key = String(document && document.key || '').replace(/\\/g, '/');
    return /^[a-z]:|^\/\//i.test(key) ? key.toLowerCase() : key;
  }
  function currentDocument() {
    if (!host) throw new Error('未安装当前宿主适配器');
    var document = host.document();
    if (state.document && documentKey(document) !== documentKey(state.document))
      throw new Error('当前文件已切换，请点击顶部刷新');
    return document;
  }
  function projectPath(suffix) { return '/api/projects/' + state.project.id + suffix; }
  function showMessage(message) {
    $('#message').textContent = message || '';
    $('#message').classList.toggle('hidden', !message);
  }
  function view(name, force) {
    if (!force && history.busy()) return;
    $$('[data-view]').forEach(function (section) {
      section.classList.toggle('hidden', section.dataset.view !== name);
    });
    $('#app').classList.toggle('mode-history', name === 'history');
    ['viewConversation', 'viewData', 'viewSettings'].forEach(function (id) {
      var button = $('#' + id);
      if (button) button.classList.toggle('nav-active',
        (name === 'conversation' && id === 'viewConversation') ||
        ((name === 'data' || name === 'variable-detail') && id === 'viewData') ||
        (name === 'settings' && id === 'viewSettings'));
    });
    showMessage('');
    closeProjectDrawer();
    window.scrollTo(0, 0);
  }
  function closeProjectDrawer() { $('#projectDrawer').classList.add('hidden'); $('#projectBackdrop').classList.add('hidden'); }
  async function openProjectDrawer() { await loadProjects(); RA.renderFiles(state.project); $('#projectDrawer').classList.remove('hidden'); $('#projectBackdrop').classList.remove('hidden'); }
  function action(fn) {
    Promise.resolve().then(fn).catch(function (error) {
      showMessage(error.message);
      RA.toast(error.message, 'err');
    });
  }
  function context() {
    currentDocument();
    return {
      projectId: state.project && state.project.id,
      documentId: state.document && state.document.id,
      documentKey: documentKey(state.document),
    };
  }
  var history = createChangeHistory({
    context: context,
    refresh: refreshProject,
    showHistory: function () { view('history', true); },
    openConversation: function (conversationId) { view('conversation', true); return RAConversation.openConversation(conversationId); },
  });
  window.RAWorkspace = {
    view: view,
    context: state,
    history: history,
    refresh: refreshProject,
    openVariable: showVariable,
    applySettings: function (settings) {
      state.liveVariableStatus = !settings.ui || settings.ui.liveVariableStatus !== false;
      renderVariables();
    },
  };

  function inputLabel(input) {
    if (input.type === 'source') {
      var source = state.project.sources.find(function (item) { return item.id === input.sourceId; });
      if (!source) return '源数据不可用';
      var document = state.project.documents.find(function (item) { return item.id === source.documentId; });
      var locator = source.locator || {};
      return (document && document.name || '文件') + (locator.address ? ' · ' + (locator.sheetName ? locator.sheetName + '!' : '') + locator.address : '');
    }
    var variable = state.project.variables.find(function (item) { return item.id === input.variableId; });
    return variable ? '变量 · ' + (variable.displayName || variable.name) : '变量不可用';
  }
  function renderVariables() {
    var project = state.project, variables = project && project.variables || [];
    var query = $('#searchVariables').value.trim().toLowerCase();
    function freshness(variable) { return (project.bindings || []).some(function (binding) { return binding.variableId === variable.id && binding.lastRenderedVariableRevision !== variable.revision; }); }
    var counts = { all: variables.length, fresh: 0, stale: 0, error: 0 };
    variables.forEach(function (variable) { if (variable.status === 'needs-ai-repair') counts.error++; else if (freshness(variable)) counts.stale++; else counts.fresh++; });
    $('#variableFilters').innerHTML = [['all','全部'],['fresh','最新'],['stale','待更新'],['error','错误']].map(function (item) { return '<button class="entity-chip '+(state.variableFilter===item[0]?'selected':'')+'" data-variable-filter="'+item[0]+'">'+item[1]+' '+counts[item[0]]+'</button>'; }).join('');
    var staleBindings = (project && project.bindings || []).filter(function (binding) { var variable = variables.find(function (item) { return item.id === binding.variableId; }); return variable && binding.lastRenderedVariableRevision !== variable.revision; });
    $('#staleOutputCount').textContent = staleBindings.length + ' 个输出待更新';
    $('#staleOutputCount').classList.toggle('hidden', !state.liveVariableStatus || staleBindings.length === 0);
    $$('[data-variable-filter]').forEach(function (button) { button.onclick = function () { state.variableFilter = button.dataset.variableFilter; renderVariables(); }; });
    $('#projectButton').textContent = project ? project.name + ' ▾' : '选择项目 ▾';
    $('#dataCount').textContent = variables.length || '';
    RA.renderFiles(project);
    var matches = variables.filter(function (variable) {
      var matchesFilter = state.variableFilter === 'all' || state.variableFilter === 'error' && variable.status === 'needs-ai-repair' || state.variableFilter === 'stale' && variable.status !== 'needs-ai-repair' && freshness(variable) || state.variableFilter === 'fresh' && variable.status !== 'needs-ai-repair' && !freshness(variable);
      return matchesFilter && ((variable.displayName || variable.name) + ' ' + (variable.description || '')).toLowerCase().includes(query);
    });
    $('#variableList').innerHTML = matches.length ? matches.map(function (variable) {
      var stale = freshness(variable);
      var status = variable.status === 'needs-ai-repair' ? '错误' : stale ? '待更新' :
        variable.explanation && variable.explanation.revision !== variable.revision ? '说明待更新' : '';
      var source = (variable.inputs || []).map(inputLabel).join('、');
      var usageCount = (project.bindings || []).filter(function (binding) { return binding.variableId === variable.id; }).length;
      return '<article class="data-item"><div class="data-title"><button data-variable="' + esc(variable.id) + '">' + esc(variable.displayName || variable.name) + '</button>' +
        '<span class="chip">' + (status ? esc(status) + ' · ' : '') + esc(variable.valueType === 'table' ? '表格' : variable.valueType === 'number' ? '数值' : '文本') + '</span></div>' +
        '<div class="value-summary">' + esc(variable.valueType === 'table' ? (variable.value || []).length + ' 行 · ' + (variable.columns || []).length + ' 列' : variable.value) + '</div>' +
        '<div class="data-description">' + esc(variable.description || '尚无用途说明') + '</div>' +
        '<div class="data-origin">来源：' + esc(source || '不可用') + ' · 使用位置：' + usageCount + ' · 更新于：' + esc(variable.updatedAt ? new Date(variable.updatedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—') + '</div><div class="item-actions"><button class="quiet" data-variable="' + esc(variable.id) + '">查看详情</button></div></article>';
    }).join('') : '<div class="empty">' + (project ? '还没有项目变量。选中数据后点击“提取数据”，或直接在会话中描述目标。' : '先将当前文件加入项目。') + '</div>';
    $$('[data-variable]').forEach(function (button) {
      button.onclick = function () { action(function () { return showVariable(button.dataset.variable); }); };
    });
  }
  async function refreshProject() {
    if (!state.project) return;
    state.project = (await api(projectPath(''))).project;
    renderVariables();
  }
  async function showVariable(variableId) {
    await refreshProject();
    var result = await api(projectPath('/variables/' + encodeURIComponent(variableId)));
    var variable = result.variable, lineage = result.lineage || {}, explanation = variable.explanation;
    state.variable = variable;
    var revisions = (await api(projectPath('/variables/' + encodeURIComponent(variableId) + '/revisions'))).revisions || [];
    var renderHistory = (await api(projectPath('/variables/' + encodeURIComponent(variableId) + '/render-history'))).records || [];
    var inputs = (lineage.inputs || variable.inputs || []).map(inputLabel).join('；');
    var usages = lineage.usages || [];
    $('#detailTitle').textContent = variable.displayName || variable.name;
    $('#variableDetail').innerHTML = RA.previewValue(variable) +
      '<p>' + esc(variable.description || '尚未填写用途说明') + '</p>' +
      '<p class="muted">Revision ' + variable.revision + (variable.status === 'needs-ai-repair' ? ' · 计算规则需修复，当前保留上一个有效值' : '') + '</p>' +
      (variable.lastError ? '<div class="notice">' + esc(variable.lastError) + '</div>' : '') +
      '<p class="muted">输入：' + esc(inputs || '无') + '</p>' +
      '<p class="muted">被 ' + usages.length + ' 个输出引用' + (usages.length ? '：' + usages.map(function (usage) {
        var documentName = usage.document && usage.document.name || '文件';
        var target = usage.binding.target.label || usage.binding.target.shapeName || '输出';
        return documentName + ' · ' + target + (usage.freshness === 'stale' ? '（待更新）' : '（最新）');
      }).join('；') : '') + '</p>' +
      '<details><summary>最近输出修改 · ' + renderHistory.length + '</summary>' + renderHistory.slice(0,5).map(function (record) { return '<div class="revision"><span>'+esc(record.displayName || record.target && record.target.label || '文档修改')+' · '+esc(record.status)+'</span> <button class="quiet" data-open-variable-render="'+esc(record.id)+'">查看记录</button></div>'; }).join('') + '</details>' +
      (explanation ? '<details><summary>变量说明与计算规则' + (explanation.revision === variable.revision ? '' : '（已过期）') + '</summary><p>' + esc(explanation.purpose || '') + '</p><p>' + esc((explanation.calculationSummary || []).join('；')) + '</p><p class="muted">假设：' + esc((explanation.assumptions || []).join('；')) + '；已确认规则：' + esc((explanation.confirmedRules || []).join('；')) + '</p></details>' : '<p class="muted">尚无当前版本的计算说明。</p>') +
      '<details><summary>历史版本 · ' + revisions.length + '</summary>' + revisions.map(function (revision) {
        return '<div class="revision"><div class="muted">' + esc(new Date(revision.createdAt).toLocaleString()) + '</div>' + RA.previewValue(revision.variable) + '<button data-restore-variable="' + esc(revision.id) + '">恢复此版本</button></div>';
      }).join('') + '</details>';
    $$('[data-restore-variable]').forEach(function (button) {
      button.onclick = function () { action(async function () {
        if (!global.confirm('恢复该变量版本？现有文档不会自动修改。')) return;
        await api(projectPath('/variables/' + encodeURIComponent(variableId) + '/revisions'), {
          method: 'POST', body: { revisionId: button.dataset.restoreVariable, expectedVersion: variable.updatedAt },
        });
        await showVariable(variableId);
        RA.toast('变量已恢复；文档输出未改动');
      }); };
    });
    $$('[data-open-variable-render]').forEach(function (button) { button.onclick = function () { if (global.RAConversation) global.RAConversation.openRenderRecord(button.dataset.openVariableRender); }; });
    view('variable-detail', true);
  }
  async function loadProjects() {
    var result = await api('/api/projects');
    $('#projectSelect').innerHTML = '<option value="">选择项目…</option>' + (result.projects || []).map(function (project) {
      return '<option value="' + esc(project.id) + '">' + esc(project.name) + '</option>';
    }).join('');
  }
  async function joinProject(projectId) {
    if (!projectId) throw new Error('请选择项目');
    currentDocument();
    var result = await api('/api/projects/' + encodeURIComponent(projectId) + '/documents', { method: 'POST', body: state.document });
    state.document = result.document;
    state.project = (await api('/api/projects/' + encodeURIComponent(projectId))).project;
    renderVariables();
    view('conversation', true);
    await history.load();
    await RAConversation.start();
  }

  $('#projectButton').onclick = function () { action(openProjectDrawer); };
  $('#backProject').onclick = closeProjectDrawer;
  $('#viewConversation').onclick = function () { view('conversation', true); action(function () { return RAConversation.start(); }); };
  $('#viewData').onclick = function () { renderVariables(); view('data', true); };
  $('#viewSettings').onclick = function () { view('settings', true); action(function () { return RA.loadSettings(); }); };
  $('#closeSettings').onclick = function () { view('conversation', true); };
  $('#joinProject').onclick = function () { action(function () { return joinProject($('#projectSelect').value); }); };
  $('#newProject').onclick = function () { action(async function () {
    var result = await api('/api/projects', { method: 'POST', body: { name: $('#projectName').value.trim() } });
    await joinProject(result.project.id);
  }); };
  $('#projectBackdrop').onclick = closeProjectDrawer;
  $('#staleOutputCount').onclick = function () { state.variableFilter = 'stale'; view('data', true); renderVariables(); };
  $('#newVariable').onclick = function () { action(function () { return RAConversation.newVariable(); }); };
  $('#askAboutVariable').onclick = function () { action(function () {
    if (!state.variable) throw new Error('变量不存在');
    return RAConversation.referenceVariable(state.variable.id);
  }); };
  $('#searchVariables').oninput = renderVariables;
  $('#reload').onclick = function () { location.reload(); };
  $('#reloadHistory').onclick = function () { action(function () { return history.load(); }); };
  $('#undoLatest').onclick = function () { action(function () { return history.undoLatest(); }); };
  $('#undoRecentInline').onclick = function () { action(function () { return history.undoLatest(); }); };
  $('#openChangeHistory').onclick = function () { view('history', true); action(function () { return history.load(); }); };
  $$('[data-back="data"]').forEach(function (button) { button.onclick = function () { view('data', true); }; });

  async function init() {
    if (!await RA.checkCore()) throw new Error('本地服务未启动，请启动数据报告助手');
    RA.wireSettings();
    var settings = await RA.loadSettings();
    state.liveVariableStatus = !settings.ui || settings.ui.liveVariableStatus !== false;
    state.document = currentDocument();
    $('#currentFile').textContent = state.document.name;
    $('#hostState').textContent = host.label;
    var resolved = await api('/api/resolve-project', { method: 'POST', body: { documentKey: state.document.key } });
    state.project = resolved.project;
    state.document = resolved.document || state.document;
    await loadProjects();
    renderVariables();
    if (!state.project) { await openProjectDrawer(); return; }
    view('conversation', true);
    await history.load();
    await RAConversation.start();
  }
  init().catch(function (error) { showMessage(error.message); $('#hostState').textContent = '尚未就绪'; });
})();
