(function (global) {
  'use strict';
  global.createChangeHistory = function (hooks) {
    var records = [], busy = false, $ = RA.$, esc = RA.esc;
    function base(context) { return '/api/projects/' + context.projectId + '/render-records'; }
    function context() { var c = hooks.context(); if (!c.projectId || !c.documentId) throw new Error('请先加入项目'); return c; }
    function label(record) { return ({prepared:'准备中',applying:'写入中',applied:'待 AI 验证',verifying:'待 AI 验证',verified:'已验证',verify_failed:'验证失败',recovered:'已恢复',failed:'未完成'})[record.status] || record.status; }
    function actionable(record) { return record.status === 'verified'; }
    function setBusy(value) {
      busy = value;
      var app = document.querySelector('#app'); if (app) app.classList.toggle('change-busy', value);
      RA.$$('#app button, #app input, #app select, #app textarea').forEach(function (el) { if (el.closest('#renderTimeline')) return; if (value) { if (el.dataset.changeDisabled === undefined) { el.dataset.changeDisabled = el.disabled ? '1' : '0'; el.disabled = true; } } else if (el.dataset.changeDisabled !== undefined) { el.disabled = el.dataset.changeDisabled === '1'; delete el.dataset.changeDisabled; } });
    }
    function render() {
      var latest = records.find(actionable);
      $('#undoLatest').disabled = !latest || busy;
      $('#changeQuickActions').classList.toggle('hidden', !latest);
      $('#undoRecentInline').disabled = !latest || busy;
      $('#changeHistory').innerHTML = records.length ? records.map(function (record) {
        var target = record.target && (record.target.label || record.target.shapeName || record.target.documentId) || record.documentId;
        var warning = record.error && record.error.message || (record.recoveryRequired ? '需要检查恢复状态' : '');
        return '<article class="history-item"><div class="item-title"><strong>'+esc(target)+'</strong><span class="status-pill">'+esc(label(record))+'</span></div><div class="muted">'+esc(new Date(record.createdAt).toLocaleString())+' · '+esc(record.id)+'</div><p class="history-request">'+esc(record.forwardPlan&&record.forwardPlan.kind==='text'?record.forwardPlan.text:(record.variableIds||[]).join(', '))+'</p><div class="item-actions"><button class="quiet" data-render-detail="'+esc(record.id)+'">查看详情</button>'+(actionable(record)?'<button data-render-undo="'+esc(record.id)+'">撤销</button>':'')+(record.recoveryRequired?'<button class="danger" data-render-recover="'+esc(record.id)+'">检查后恢复</button>':'')+'</div><div data-render-detail-box="'+esc(record.id)+'"></div>'+(warning?'<p class="history-error">'+esc(warning)+'</p>':'')+'</article>';
      }).join('') : '<div class="empty">暂无 Render 记录。所有文档写入都会在此保留不可变记录。</div>';
      RA.$$('[data-render-undo]').forEach(function (button) { button.onclick = function () { return undo(button.dataset.renderUndo); }; });
      RA.$$('[data-render-detail]').forEach(function (button) { button.onclick = function () { return detail(button.dataset.renderDetail); }; });
      RA.$$('[data-render-recover]').forEach(function (button) { button.onclick = function () { return recover(button.dataset.renderRecover); }; });
    }
    async function load() {
      var c; try { c = context(); } catch (e) { records = []; render(); return; }
      var result = await RA.api(base(c) + '?documentId=' + encodeURIComponent(c.documentId));
      records = result.records || []; render(); return records;
    }
    async function detail(renderId) {
      var c=context(), result=await RA.api(base(c)+'/'+encodeURIComponent(renderId)), record=result.record||{}, before=record.beforeSnapshot, after=record.actualAfterSnapshot;
      var box=document.querySelector('[data-render-detail-box="'+renderId+'"]'); if(!box)return;
      box.innerHTML='<div class="diff-label">修改前</div><pre class="history-content">'+esc(before?RAChangeState.content(before):'快照已归档，详情暂不可用')+'</pre><div class="diff-label">实际修改后</div><pre class="history-content">'+esc(after?RAChangeState.content(after):'尚未捕获 After 快照')+'</pre><details><summary>程序验证与 AI 验证</summary><pre class="mono">'+esc(JSON.stringify({programVerification:record.programVerification,agentVerification:record.agentVerification,inversePlan:record.inversePlan},null,2))+'</pre></details>';
    }
    async function undo(renderId) {
      var c=context(); if(!global.confirm('将通过 Render Gateway 恢复记录中的 Before 快照。若目标已被后续手工修改，系统会拒绝覆盖。继续？'))return;
      setBusy(true);
      try { var result=await RA.api(base(c)+'/'+encodeURIComponent(renderId)+'/undo',{method:'POST',body:{}}); if(result.record.status!=='verified')throw new Error(result.record.verificationError||'撤销已执行，但仍待验证'); if(hooks.refresh)await hooks.refresh(); await load(); RA.toast('已创建新的 Undo Render 记录'); }
      catch(error){$('#changeFeedback').className='change-feedback error';$('#changeFeedback').textContent='撤销未完成：'+error.message;RA.toast(error.message,'err')}
      finally{setBusy(false)}
    }
    async function undoLatest() {
      var latest = records.find(actionable);
      if (latest) return undo(latest.id);
    }
    async function recover(renderId) {
      var c=context();if(!global.confirm('无法自动判断中断期间的目标变化。请先检查原文，确认要恢复到 Render 前快照后再继续。'))return;
      setBusy(true);try{await RA.api(base(c)+'/'+encodeURIComponent(renderId)+'/recover',{method:'POST',body:{confirm:true}});await load();RA.toast('已创建恢复 Render 记录')}catch(error){RA.toast(error.message,'err')}finally{setBusy(false)}
    }
    $('#undoLatest').onclick=function(){var latest=records.find(actionable);if(latest)undo(latest.id)};
    $('#undoRecentInline').onclick=function(){var latest=records.find(actionable);if(latest)undo(latest.id)};
    $('#openChangeHistory').onclick=function(){if(hooks.showHistory)hooks.showHistory();load().catch(function(error){RA.toast(error.message,'err')})};
    $('#reloadHistory').onclick=function(){if(!busy)load().catch(function(error){RA.toast(error.message,'err')})};
    return {load:load,undo:undo,undoLatest:undoLatest,busy:function(){return busy}};
  };
})(window);
