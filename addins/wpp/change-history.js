(function (global) {
  'use strict';
  var state = global.RAChangeState;
  global.createChangeHistory = function (hooks) {
    var changes = [], busy = false, queryVersion = 0, lockedControls = [];
    var $ = RA.$, esc = RA.esc;
    function base(context) { return '/api/projects/' + context.projectId + '/changes'; }
    function context() { var c = hooks.context(); if (!c.projectId || !c.documentId) throw new Error('请先加入项目'); return c; }
    function assertDocument(c) { var now = context(); if (now.documentKey !== c.documentKey || now.projectId !== c.projectId || now.documentId !== c.documentId) throw new Error('文稿已切换，操作已停止。请返回原文稿的修改历史继续处理。'); }
    function lock(value) {
      busy = value; document.querySelector('#app').classList.toggle('change-busy', value);
      if(value) { lockedControls = RA.$$('#app button, #app input, #app select, #app textarea').map(function(el){var saved={el:el,disabled:el.disabled};el.disabled=true;return saved;}); }
      else { lockedControls.forEach(function(saved){saved.el.disabled=saved.disabled;}); lockedControls=[]; }
    }
    function status(message, error) { var box = $('#changeFeedback'); box.className = 'change-feedback' + (error ? ' error' : ''); box.textContent = message; }
    async function transition(c, record, index, action, snapshot, error) {
      var url = base(c) + '/' + record.id + '/entries/' + index;
      var body = { action: action, snapshot: snapshot, error: error || '' };
      // Transitions are idempotent, so retrying a lost response cannot apply twice.
      try { return (await RA.api(url, { method: 'POST', body: body })).change; }
      catch (first) { return (await RA.api(url, { method: 'POST', body: body })).change; }
    }
    function active(c) { return c.entries.some(function (e) { return ['applied', 'prepared', 'undoing'].indexOf(e.status) >= 0; }); }
    function pending(c) { return c.entries.some(function (e) { return e.status === 'prepared' || e.status === 'undoing'; }); }
    function label(c) {
      if (pending(c)) return '需要检查';
      var applied = c.entries.filter(function (e) { return e.status === 'applied'; }).length;
      if (applied) return '已应用 ' + applied + '/' + c.entries.length;
      if (c.entries.some(function (e) { return e.status === 'undone'; })) return '已撤销';
      return '未应用';
    }
    function render() {
      var newest = changes.find(active), names = { prepared: '执行中断', applied: '已应用', failed: '未应用', undoing: '撤销中断', undone: '已撤销' };
      $('#undoLatest').disabled = !newest || busy;
      $('#changeQuickActions').classList.toggle('hidden', !newest);
      $('#undoRecentInline').disabled = !newest || busy;
      $('#undoRecentInline').textContent = newest && pending(newest) ? '检查中断操作' : '撤销最近修改';
      $('#undoLatest').textContent = newest && pending(newest) ? '检查中断操作' : '撤销最近修改';
      $('#changeHistory').innerHTML = changes.length ? changes.map(function (c) {
        return '<article class="history-item"><div class="item-title"><strong>' + esc(c.label) + '</strong><span class="status-pill">' + esc(label(c)) + '</span></div><div class="muted">' + esc(new Date(c.createdAt).toLocaleString()) + '</div><details><summary>查看修改内容 · ' + c.entries.length + ' 个对象</summary>' + c.entries.map(function (e) {
          return '<div class="history-entry"><strong>' + esc(e.target.label || ((e.target.slideIndex || '?') + ' 页 · ' + (e.target.shapeName || e.target.shapeId))) + '</strong><div class="muted">' + esc(names[e.status]) + '</div><p class="history-request">' + esc(e.afterBinding.description || '按已有规则更新') + '</p><div class="diff-label">修改前</div><pre class="history-content">' + esc(state.content(e.before)) + '</pre><div class="diff-label">修改后' + (e.after ? '' : '（尚未确认执行结果）') + '</div><pre class="history-content">' + esc(e.after ? state.content(e.after) : '请检查原稿中的对象') + '</pre>' + (e.error ? '<p class="history-error">' + esc(e.error) + '</p>' : '') + '<details><summary>规则与格式记录</summary><pre class="mono">' + esc(JSON.stringify({ beforeBinding: e.beforeBinding, afterBinding: e.afterBinding, before: e.before, after: e.after }, null, 2)) + '</pre></details>' + (e.status === 'applied' ? '<button class="quiet" data-adjust-history="' + esc(e.afterBinding.id) + '">继续调整</button>' : '') + '</div>';
        }).join('') + '</details>' + (newest && newest.id === c.id ? '<button data-undo-change="' + esc(c.id) + '">' + (pending(c) ? '检查并恢复中断操作' : '撤销此次修改') + '</button>' : '') + '</article>';
      }).join('') : '<div class="empty">暂无修改记录。此后通过插件应用的修改会保存在这里。</div>';
      RA.$$('[data-undo-change]').forEach(function (b) { b.onclick = function () { undo(b.dataset.undoChange); }; });
      RA.$$('[data-adjust-history]').forEach(function (b) { b.onclick = function () { if (!busy) hooks.adjust(b.dataset.adjustHistory); }; });
    }
    async function load() {
      var version = ++queryVersion, c;
      try { c = context(); } catch (e) { changes = []; render(); return; }
      var result = await RA.api(base(c) + '?documentId=' + encodeURIComponent(c.documentId));
      if (version !== queryVersion) return;
      assertDocument(c); changes = result.changes || []; render();
    }
    async function run(requests, title) {
      if (busy) throw new Error('请等待当前修改完成');
      var c = context(), record, failed = [], applied = 0; lock(true);
      try {
        await load(); assertDocument(c);
        if (changes.some(pending)) throw new Error('有中断操作，请先在修改历史中检查并恢复');
        var entries = requests.map(function (request) {
          var shape = hooks.findShape(request.target); state.preflight(shape, request.plan);
          if(request.expectedBefore && !state.equal(state.capture(shape),request.expectedBefore)) throw new Error('对象已变化，请重新生成修改方案');
          return { bindingId: request.bindingId, draftId: request.draftId, acceptRisk: request.acceptRisk, approveDynamicCapability: request.approveDynamicCapability, expectedPlan: request.plan, before: state.capture(shape) };
        });
        var body = { requestId: RA.makeTraceId(), documentId: c.documentId, label: title, entries: entries };
        try { record = (await RA.api(base(c), { method: 'POST', body: body })).change; }
        catch (first) { record = (await RA.api(base(c), { method: 'POST', body: body })).change; }
        for (var i = 0; i < record.entries.length; i++) {
          assertDocument(c);
          var entry = record.entries[i];
          if (entry.status !== 'prepared') throw new Error('操作已处理，请刷新修改历史');
          var shape = hooks.findShape(entry.target), before = state.capture(shape);
          if (!state.equal(before, entry.before)) throw new Error('对象在准备期间被修改，已停止。请到修改历史检查。');
          status('正在应用 ' + (i + 1) + '/' + record.entries.length + ' · ' + (entry.target.label || entry.target.shapeName || ''));
          var after, hostError;
          try { state.apply(shape, entry.plan); after = state.capture(shape); }
          catch (e) { hostError = e; }
          if (hostError) {
            try { state.restore(shape, entry.before); }
            catch (restoreError) { throw new Error(hostError.message + '；恢复未完成：' + restoreError.message); }
            record = await transition(c, record, i, 'fail', state.capture(shape), hostError.message);
            failed.push((entry.target.label || entry.target.shapeName || '对象') + '：' + hostError.message);
          } else {
            // Do not roll back on a transport error: the commit may have succeeded.
            record = await transition(c, record, i, 'complete', after); applied++;
          }
        }
        status('已应用 ' + applied + '/' + requests.length + ' 个对象。' + (failed.length ? failed.join('；') : '不满意可撤销最近修改，或继续调整。'), !!failed.length);
        return { change: record, applied: applied, failed: failed };
      } catch (e) {
        status(e.message + (record ? ' 修改前状态已保存，请打开修改历史处理。' : ''), true); throw e;
      } finally {
        lock(false);
        try { await load(); } catch (e) { status('无法读取修改历史：' + e.message + '。恢复连接后请刷新历史。', true); }
      }
    }
    async function undo(id) {
      if (busy) return;
      var c, record;
      try {
        c = context(); lock(true); await load(); assertDocument(c);
        record = changes.find(active);
        if (!record || (id && record.id !== id)) throw new Error('请先撤销最近一次修改');
        hooks.showHistory();
        // Inspect every target before undoing any of them, then recheck after each await.
        for (var k = record.entries.length - 1; k >= 0; k--) {
          var item = record.entries[k];
          if (item.status === 'applied' && !state.equal(state.capture(hooks.findShape(item.target)), item.after) && !state.equal(state.capture(hooks.findShape(item.target)), item.before)) throw new Error((item.target.label || '目标对象') + '已被后续修改，不能自动撤销。请先恢复后续编辑。');
        }
        if (pending(record) && !global.confirm('此次操作曾中断。恢复将把记录中的目标对象还原到修改前，并撤回对应绑定变更。\n\n中断后对这些对象的手工编辑也可能被覆盖。请先在历史详情和原稿中检查，再继续恢复。')) return;
        for (var i = record.entries.length - 1; i >= 0; i--) {
          assertDocument(c); var e = record.entries[i];
          if (e.status === 'failed' || e.status === 'undone') continue;
          var shape = hooks.findShape(e.target), current = state.capture(shape);
          if (e.status === 'applied' && !state.equal(current, e.after) && !state.equal(current, e.before)) throw new Error('目标已被修改，撤销已停止');
          if (e.status !== 'undoing') record = await transition(c, record, i, e.status === 'prepared' ? 'recover-start' : 'undo-start', current);
          assertDocument(c); shape = hooks.findShape(e.target);
          if (!state.equal(state.capture(shape), current)) throw new Error('目标在撤销准备期间被修改，已停止');
          if (!state.equal(current, e.before)) state.restore(shape, e.before);
          record = await transition(c, record, i, 'undo-complete', state.capture(shape));
        }
        status('已恢复修改前的内容、格式和绑定规则。'); RA.toast('已撤销此次修改');
        await hooks.refresh();
      } catch (e) { status('撤销未完成：' + e.message, true); RA.toast(e.message, 'err'); }
      finally { lock(false); try { await load(); } catch (e) { status('历史暂时无法刷新，请恢复连接后重试。', true); } }
    }
    $('#undoLatest').onclick = function () { undo(); };
    $('#undoRecentInline').onclick = function () { undo(); };
    $('#openChangeHistory').onclick = function () { if(!busy){hooks.showHistory();load().catch(function(e){status(e.message,true)});} };
    $('#reloadHistory').onclick = function () { if (!busy) load().catch(function (e) { status(e.message, true); }); };
    return { run: run, load: load, undo: undo, busy: function () { return busy; } };
  };
})(window);
