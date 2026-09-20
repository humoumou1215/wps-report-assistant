(function(){
  'use strict';
  var $=RA.$,$$=RA.$$,api=RA.api,toast=RA.toast,esc=RA.esc;
  var ctx={app:null,doc:null,project:null,document:null,target:null,projects:[],bindingDraft:null,previewVersion:0,refreshBusy:false,failedBatch:[],editingBindingId:null};
  function setMode(mode){if(history&&history.busy())return;var app=$('#app');if(!app)return;['results','create','project','history'].forEach(function(m){app.classList.remove('mode-'+m)});app.classList.add('mode-'+mode);var names={results:'Results',create:'Create',project:'Project',history:'History'};$$('.workspace-nav button').forEach(function(b){b.classList.toggle('nav-active',b.id==='view'+names[mode])});if(mode==='history')history.load().catch(function(e){toast(e.message,'err')})}
  var history=createChangeHistory({context:function(){if(docKey(getDoc())!==docKey(ctx.doc))throw new Error('文稿已切换，请刷新插件后继续');return {projectId:ctx.project&&ctx.project.id,documentId:ctx.document&&ctx.document.id,documentKey:docKey(getDoc())}},findShape:findShape,refresh:render,adjust:editBinding,showHistory:function(){var app=$('#app');['results','create','project'].forEach(function(m){app.classList.remove('mode-'+m)});app.classList.add('mode-history');$$('.workspace-nav button').forEach(function(b){b.classList.toggle('nav-active',b.id==='viewHistory')})}});

  function docKey(d){return String(d&&d.key||'').toLowerCase().replace(/\\/g,'/')}
  function criticText(c){if(!c||c.via==='skipped')return '未启用语义审查';return c.passed?'语义审查通过':'语义审查未通过'}
  async function ensureCurrentDocument(){var current=getDoc();if(ctx.doc&&docKey(current)!==docKey(ctx.doc)){clearBindingPreview();ctx.target=null;ctx.doc=current;await resolveCurrent();throw new Error('当前演示文稿已切换，请重新读取目标对象')}return current}

  function getDoc(){
    var app=ctx.app||RA.getApp('wpp');if(!app)throw new Error('没有检测到 WPS 演示宿主');var p=app.ActivePresentation;if(!p)throw new Error('没有活动演示文稿');
    var full='',path='';try{full=String(p.FullName||'').trim()}catch(e){}try{path=String(p.Path||'').trim()}catch(e){}if(!path&&!/[\\/]/.test(full))throw new Error('请先保存当前 PPT 文件，再加入项目');var key=full||path+'/'+String(p.Name||'');return {key:key,name:String(p.Name||key),kind:'wpp'};
  }
  function snapshotTable(shape){
    try{
      var t=shape.Table,rows=Number(t.Rows.Count||0),cols=Number(t.Columns.Count||0),matrix=[];
      var maxRows=Math.min(rows,12),maxCols=Math.min(cols,20);
      for(var r=1;r<=maxRows;r++){
        var line=[];
        for(var c=1;c<=maxCols;c++){
          var txt='';try{txt=String(t.Cell(r,c).Shape.TextFrame.TextRange.Text||'')}catch(e){}
          line.push(txt);
        }
        matrix.push(line);
      }
      return {rows:rows,columns:cols,cells:matrix,header:matrix.length?matrix[0]:[]};
    }catch(e){return null}
  }
  function currentTarget(){
    var app=ctx.app,win=app.ActiveWindow;if(!win)throw new Error('没有活动 PPT 窗口');var sel=win.Selection;if(!sel)throw new Error('请先选中 PPT 对象');var shape=null;try{shape=sel.ShapeRange.Item(1)}catch(e){throw new Error('请选中一个文本框或表格')}
    var slide=null;try{slide=win.View.Slide}catch(e){}if(!slide)throw new Error('无法取得当前幻灯片');var kind='shape';try{if(shape.HasTable===true||shape.HasTable===-1||shape.Table)kind='table'}catch(e){}if(kind!=='table'){try{if(shape.HasTextFrame===true||shape.HasTextFrame===-1)kind='text'}catch(e){}}
    if(kind!=='table'&&kind!=='text')throw new Error('当前只支持绑定文本框或表格');var slideId=0,index=0;try{slideId=Number(slide.SlideID||0)}catch(e){}try{index=Number(slide.SlideIndex||slide.Index||0)}catch(e){}
    var out={kind:kind,slideId:slideId,slideIndex:index,shapeId:Number(shape.Id),shapeName:String(shape.Name||''),hasTextFrame:kind==='text'};
    if(kind==='table')out.snapshot=snapshotTable(shape);
    else{try{out.snapshot={text:String(shape.TextFrame.TextRange.Text||'')}}catch(e){}}
    return out;
  }
  async function loadProjects(){var r=await api('/api/projects');ctx.projects=r.projects||[];$('#projectSelect').innerHTML='<option value="">选择项目…</option>'+ctx.projects.map(function(p){return '<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>'}).join('')}
  async function fetchProject(id){return (await api('/api/projects/'+id)).project}
  function updateProjectView(p){RA.renderFiles(p);$('#projectBadge').textContent=p?p.name:'未绑定项目';if(p)$('#projectSelect').value=p.id}
  async function render(){
    if(!ctx.project){$('#variableSelect').innerHTML='<option value="">先把当前 PPT 加入项目</option>';$('#bindings').innerHTML='<div class="empty">暂无绑定</div>';return}
    ctx.project=await fetchProject(ctx.project.id);updateProjectView(ctx.project);var vars=ctx.project.variables||[];$('#variableSelect').innerHTML='<option value="">选择当前项目变量…</option>'+vars.map(function(v){var s=ctx.project.sources.find(function(x){return x.id===v.sourceId}),d=s&&ctx.project.documents.find(function(x){return x.id===s.documentId});return '<option value="'+v.id+'">'+esc(v.displayName||v.name)+' · '+esc(d&&d.name||'')+'</option>'}).join('');
    var mine=(ctx.project.bindings||[]).filter(function(b){return b.documentId===ctx.document.id});$('#navResultCount').textContent=mine.length?'· '+mine.length:'';$('#bindings').innerHTML=mine.length?mine.map(function(b){var v=vars.find(function(x){return x.id===b.variableId});return '<div class="item"><div class="item-title"><span>'+esc(v&&v.displayName||b.variableId)+'</span><button class="quiet" data-delbind="'+b.id+'">删除</button></div><div class="muted">第 '+esc(b.target.slideIndex||'?')+' 页 · '+esc(b.target.shapeName||b.target.shapeId)+' · '+esc(b.renderer.kind)+'</div><div class="result-summary">'+(b.renderer.kind==='table'?'表格绑定':'文本绑定')+'</div><div class="muted">'+esc(b.description||'')+'</div><div class="row" style="margin-top:6px"><button data-editbind="'+b.id+'">检查与调整</button><button data-apply="'+b.id+'">更新此对象</button></div></div>'}).join(''):'<div class="empty">当前 PPT 暂无绑定</div>';
    $$('[data-editbind]').forEach(function(x){x.onclick=function(){editBinding(x.dataset.editbind)}});$$('[data-apply]').forEach(function(x){x.onclick=function(){applyBinding(x.dataset.apply).catch(function(e){toast(e.message,'err')})}});$$('[data-delbind]').forEach(function(x){x.onclick=function(){deleteBinding(x.dataset.delbind)}});
  }
  async function resolveCurrent(){ctx.doc=getDoc();$('#hostState').textContent='已连接 WPS 演示';$('#docInfo').textContent=ctx.doc.name+' · '+ctx.doc.key;var sub=document.querySelector('.sub');if(sub)sub.textContent=ctx.doc.name;var r=await api('/api/resolve-project',{method:'POST',body:{documentKey:ctx.doc.key}});ctx.project=r.project;ctx.document=r.document;if(ctx.project){ctx.project=await fetchProject(ctx.project.id);updateProjectView(ctx.project);if(sub)sub.textContent=ctx.project.name+' · '+ctx.doc.name}else{updateProjectView(null);RA.renderFiles(null)}await render()}
  async function bindCurrentTo(id){if(!id)throw new Error('请选择项目');await ensureCurrentDocument();clearBindingPreview();var r=await api('/api/projects/'+id+'/documents',{method:'POST',body:ctx.doc});ctx.document=r.document;ctx.project=await fetchProject(id);updateProjectView(ctx.project);await render();toast('当前 PPT 已加入“'+ctx.project.name+'”')}
  async function createAndBind(){var name=$('#newProjectName').value.trim();if(!name)throw new Error('请输入项目名称');var r=await api('/api/projects',{method:'POST',body:{name:name}});await loadProjects();$('#projectSelect').value=r.project.id;await bindCurrentTo(r.project.id);$('#newProjectName').value='';$('#newProjectRow').classList.remove('show')}
  async function previewSelectedProject(){var id=$('#projectSelect').value;clearBindingPreview();if(!id){if(!ctx.project)RA.renderFiles(null);return}try{RA.renderFiles(await fetchProject(id))}catch(e){}}
  function findSlide(target){
    var slides=ctx.app.ActivePresentation.Slides;if(target.slideId){try{if(typeof slides.FindBySlideID==='function'){var s=slides.FindBySlideID(target.slideId);if(s)return s}}catch(e){}try{for(var i=1;i<=slides.Count;i++){var x=slides.Item(i);if(Number(x.SlideID)===Number(target.slideId))return x}}catch(e){}}
    if(target.slideId)throw new Error('找不到原目标幻灯片，请重新选择目标');if(target.slideIndex)return slides.Item(target.slideIndex);throw new Error('找不到目标幻灯片');
  }
  function findShape(target){var slide=findSlide(target);for(var i=1;i<=slide.Shapes.Count;i++){var s=slide.Shapes.Item(i);if(Number(s.Id)===Number(target.shapeId))return s}throw new Error('找不到目标对象：第 '+target.slideIndex+' 页 '+target.shapeName)}
  function preflightPlanToShape(shape,plan){RAChangeState.preflight(shape,plan)}
  async function applyBinding(id){
    await ensureCurrentDocument();var r=await api('/api/projects/'+ctx.project.id+'/bindings/'+id+'/plan');
    await history.run([{bindingId:id,target:r.binding.target,plan:r.plan}], '更新对象');await render();
  }
  async function editBinding(id){
    try{if(history.busy())return;await ensureCurrentDocument();ctx.project=await fetchProject(ctx.project.id);var b=ctx.project.bindings.find(function(x){return x.id===id});if(!b)throw new Error('绑定不存在');
      clearBindingPreview();ctx.editingBindingId=id;ctx.target=JSON.parse(JSON.stringify(b.target));var shape=findShape(ctx.target);
      ctx.target.snapshot=ctx.target.kind==='table'?snapshotTable(shape):{text:String(shape.TextFrame.TextRange.Text||'')};
      $('#variableSelect').value=b.variableId;$('#bindingDescription').value=b.description||'';$('#targetInfo').textContent='第 '+b.target.slideIndex+' 页 · '+b.target.shapeName;
      $('#createSection h2').textContent='检查与调整';$('#createBinding').disabled=false;$('#captureTarget').disabled=true;
      $('#planPreview').innerHTML='<div class="preview-card"><strong>当前对象内容</strong><div class="history-content">'+esc(ctx.target.kind==='table'?(ctx.target.snapshot.cells||[]).map(function(row){return row.join(' | ')}).join('\n'):ctx.target.snapshot.text)+'</div><div class="muted">修改上方展示要求后生成方案，应用后可在修改历史中撤销。</div></div>';setMode('create');
    }catch(e){toast(e.message,'err')}
  }
  async function deleteBinding(id){try{if(history.busy())return;await api('/api/projects/'+ctx.project.id+'/bindings/'+id,{method:'DELETE'});toast('绑定已删除');await render()}catch(e){toast(e.message,'err')}}

  function clearBindingPreview(){ctx.previewVersion++;ctx.bindingDraft=null;var box=$('#planPreview');if(box)box.innerHTML=''}
  function renderBindingPreview(r){
    ctx.bindingDraft=r;var repairs=Math.max(0,(r.attempts||[]).filter(function(x){return x.via==='ai'}).length-1),gen=r.generation==='ai-dynamic'?'AI 临时能力':(r.generation==='ai'?'AI 规则':'内置规则'),repairText=repairs?(' · 自动修复 '+repairs+' 次'):'';
    var plan=r.plan||{},summary=plan.kind==='text'?('将写入文本：'+String(plan.text==null?'':plan.text)):('将写入表格：'+((plan.rows||[]).length)+' 行数据');
    var critic=r.critic||{},issues=(critic.issues||[]),risk='';
    if(r.dynamicCapability){risk='<div class="risk-card"><strong>本次使用 AI 临时沙箱能力</strong><div class="muted">该程序已经通过能力图校验和无副作用快速试跑，但属于 AI 现场生成逻辑。请检查预览结果和程序后再确认。</div><label><input id="approveDynamicBinding" type="checkbox" style="width:auto"> 我已检查并确认本次临时能力，可以写入 PPT</label></div>'}
    var direct=plan.kind==='table'?'<div class="tablewrap"><table><thead><tr>'+((plan.header||[]).map(function(h){return '<th>'+esc(h)+'</th>'}).join(''))+'</tr></thead><tbody>'+((plan.rows||[]).slice(0,20).map(function(row){return '<tr>'+row.map(function(v){return '<td>'+esc(v)+'</td>'}).join('')+'</tr>'}).join(''))+'</tbody></table></div>':'';
    $('#planPreview').innerHTML='<div class="preview-card"><div class="preview-head"><strong>修改方案</strong><span class="status-pill '+(critic.via==='skipped'||critic.passed?'ok':'warn')+'">'+esc(criticText(critic))+'</span></div><div class="muted">'+esc(gen+repairText)+' · 还未修改 PPT</div><div class="preview-summary">'+esc(summary)+'</div>'+direct+risk+'<details><summary>规则与检查详情</summary><div class="mono">'+esc(JSON.stringify({critic:critic,graphValidation:r.graphValidation,renderer:r.renderer,plan:r.plan},null,2))+'</div></details><div class="preview-actions"><button id="cancelBindingDraft">返回修改</button><button id="confirmBindingDraft" class="primary"'+(r.dynamicCapability?' disabled':'')+'>应用并记录修改</button></div></div>';
    $('#cancelBindingDraft').onclick=clearBindingPreview;$('#confirmBindingDraft').onclick=applyBindingPreview;
    var ack=$('#approveDynamicBinding');if(ack)ack.onchange=function(){$('#confirmBindingDraft').disabled=!ack.checked};
  }
  async function createBindingPreview(){
    if(history.busy())return;
    var version=ctx.previewVersion,traceId=(ctx.target&&ctx.target.traceId)||RA.makeTraceId();try{
      if(!ctx.project||!ctx.document)throw new Error('请先把当前 PPT 加入项目');if(!ctx.target)throw new Error('请先读取当前 PPT 选中对象');var variableId=$('#variableSelect').value;if(!variableId)throw new Error('请选择变量');
      clearBindingPreview();version=ctx.previewVersion;await ensureCurrentDocument();var targetBody={kind:ctx.target.kind,slideId:ctx.target.slideId,slideIndex:ctx.target.slideIndex,shapeId:ctx.target.shapeId,shapeName:ctx.target.shapeName,hasTextFrame:ctx.target.hasTextFrame,snapshot:ctx.target.snapshot||null};var originalShape=findShape(targetBody),originalState=RAChangeState.capture(originalShape);targetBody.snapshot=targetBody.kind==='table'?snapshotTable(originalShape):{text:String(originalShape.TextFrame.TextRange.Text||'')};var request={bindingId:ctx.editingBindingId,variableId:variableId,documentId:ctx.document.id,target:targetBody,description:$('#bindingDescription').value.trim(),traceId:traceId};$('#createBinding').disabled=true;$('#createBinding').textContent='校验生成中…';
      var r=await api('/api/projects/'+ctx.project.id+'/bindings/preview',{method:'POST',body:request});if(version!==ctx.previewVersion||docKey(getDoc())!==docKey(ctx.doc)){return}var shape=findShape(targetBody);if(!RAChangeState.equal(RAChangeState.capture(shape),originalState))throw new Error('生成期间目标对象已被修改，请重新生成');preflightPlanToShape(shape,r.plan);r.__target=targetBody;r.__docKey=ctx.doc.key;r.__before=originalState;renderBindingPreview(r);setMode('create');toast(r.generation==='ai'?'修改方案已生成，应用后直接修改原稿':'修改方案已生成，应用后可撤销');
    }catch(e){await RA.trace({traceId:traceId,projectId:ctx.project&&ctx.project.id,component:'wps-wpp',stage:'preview',action:'binding-preview',status:'error',message:e.message});toast(e.message,'err');clearBindingPreview();$('#planPreview').innerHTML='<div class="change-feedback error" role="alert">'+esc(e.message)+'</div>';version=ctx.previewVersion}
    finally{if(ctx.previewVersion===version){$('#createBinding').disabled=!(ctx.project&&ctx.target&&$('#variableSelect').value);$('#createBinding').textContent='生成修改方案'}}
  }
  async function applyBindingPreview(){
    if(!ctx.bindingDraft||history.busy())return;var draft=ctx.bindingDraft,btn=$('#confirmBindingDraft');
    try{
      await ensureCurrentDocument();if(docKey({key:draft.__docKey})!==docKey(ctx.doc))throw new Error('文稿已切换，请重新生成');
      if(!RAChangeState.equal(RAChangeState.capture(findShape(draft.__target)),draft.__before))throw new Error('目标在生成方案后被修改，请重新生成');
      var ack=$('#approveDynamicBinding');btn.disabled=true;
      var result=await history.run([{draftId:draft.draftId,target:draft.__target,plan:draft.plan,expectedBefore:draft.__before,approveDynamicCapability:!draft.dynamicCapability||(ack&&ack.checked)}],ctx.editingBindingId?'调整展示要求':'创建绑定');
      clearBindingPreview();ctx.editingBindingId=null;await render();setMode('results');toast(result.applied?'已应用，可在修改历史中撤销':'未应用，请查看修改历史');
    }catch(e){toast(e.message,'err');if(btn)btn.disabled=false}
  }
  async function refreshAll(){
    if(history.busy()||ctx.refreshBusy)return;ctx.refreshBusy=true;$('#refreshAll').disabled=true;
    try{await ensureCurrentDocument();if(!ctx.project)throw new Error('请先加入项目');ctx.project=await fetchProject(ctx.project.id);var mine=ctx.project.bindings.filter(function(b){return b.documentId===ctx.document.id});if(!mine.length){toast('暂无绑定');return}
      var requests=[];for(var i=0;i<mine.length;i++){var r=await api('/api/projects/'+ctx.project.id+'/bindings/'+mine[i].id+'/plan');requests.push({bindingId:mine[i].id,target:r.binding.target,plan:r.plan})}
      await history.run(requests,'更新全部绑定');await render();
    }catch(e){toast(e.message,'err')}finally{ctx.refreshBusy=false;$('#refreshAll').disabled=false}
  }
  async function init(){RA.wireSettings(function(){return ctx.project&&ctx.project.id});await RA.checkCore();await RA.loadSettings().catch(function(){});ctx.app=RA.getApp('wpp');if(!ctx.app){$('#hostState').textContent='未连接 WPS';$('#hostBlock').classList.remove('hidden');return}$('#hostBlock').classList.add('hidden');try{await loadProjects();await resolveCurrent();setMode(ctx.project?'results':'project');await history.load()}catch(e){$('#hostState').textContent='WPS 已连接';$('#docInfo').textContent=e.message;setMode('project');toast(e.message,'err')}}

  $('#toggleNewProject').onclick=function(){$('#newProjectRow').classList.toggle('show')};$('#createProject').onclick=function(){createAndBind().then(function(){setMode('results')}).catch(function(e){toast(e.message,'err')})};$('#bindProject').onclick=function(){bindCurrentTo($('#projectSelect').value).then(function(){setMode('results')}).catch(function(e){toast(e.message,'err')})};$('#projectSelect').onchange=previewSelectedProject;
  $('#viewResults').onclick=function(){setMode('results')};$('#viewHistory').onclick=function(){setMode('history')};$('#viewCreate').onclick=function(){if(history.busy())return;ctx.editingBindingId=null;clearBindingPreview();$('#captureTarget').disabled=false;ctx.target=null;$('#targetInfo').textContent='请在 PPT 中选中一个文本框或表格';$('#bindingDescription').value='';$('#createBinding').disabled=true;$('#createSection h2').textContent='新建绑定';if(!ctx.project){setMode('project');return}setMode('create')};$('#viewProject').onclick=function(){setMode('project')};$('#cancelCreate').onclick=function(){if(history.busy())return;ctx.editingBindingId=null;clearBindingPreview();setMode('results')};
  $('#captureTarget').onclick=async function(){try{clearBindingPreview();await ensureCurrentDocument();ctx.target=currentTarget();ctx.target.traceId=RA.makeTraceId();$('#targetInfo').textContent='第 '+ctx.target.slideIndex+' 页 · '+ctx.target.shapeName+' · '+ctx.target.kind;$('#createBinding').disabled=!(ctx.project&&$('#variableSelect').value);await RA.trace({traceId:ctx.target.traceId,projectId:ctx.project&&ctx.project.id,component:'wps-wpp',stage:'target',action:'capture-target',status:'ok',sensitive:true,data:{document:ctx.doc&&ctx.doc.name,target:ctx.target}});toast('已读取 PPT 目标对象')}catch(e){ctx.target=null;$('#createBinding').disabled=true;await RA.trace({traceId:ctx.target&&ctx.target.traceId,projectId:ctx.project&&ctx.project.id,component:'wps-wpp',stage:'target',action:'capture-target',status:'error',message:e.message});toast(e.message,'err')}};
  $('#variableSelect').onchange=function(){clearBindingPreview();$('#createBinding').disabled=!(ctx.project&&ctx.target&&$('#variableSelect').value)};$('#bindingDescription').oninput=clearBindingPreview;$('#createBinding').onclick=createBindingPreview;$('#refreshAll').onclick=refreshAll;$('#reload').onclick=function(){location.reload()};init().catch(function(e){toast(e.message,'err')});
})();
