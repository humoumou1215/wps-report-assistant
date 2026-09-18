(function(){
  'use strict';
  var $=RA.$,$$=RA.$$,api=RA.api,toast=RA.toast,esc=RA.esc;
  var ctx={app:null,doc:null,project:null,document:null,target:null,projects:[],bindingDraft:null};

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
    var mine=(ctx.project.bindings||[]).filter(function(b){return b.documentId===ctx.document.id});$('#bindings').innerHTML=mine.length?mine.map(function(b){var v=vars.find(function(x){return x.id===b.variableId});return '<div class="item"><div class="item-title"><span>'+esc(v&&v.displayName||b.variableId)+'</span><button class="danger" data-delbind="'+b.id+'">删除</button></div><div class="muted">第 '+esc(b.target.slideIndex||'?')+' 页 · '+esc(b.target.shapeName||b.target.shapeId)+' · '+esc(b.renderer.kind)+'</div><div class="muted">'+esc(b.description||'')+'</div><div class="row" style="margin-top:6px"><button data-apply="'+b.id+'">应用此绑定</button></div></div>'}).join(''):'<div class="empty">当前 PPT 暂无绑定</div>';
    $$('[data-apply]').forEach(function(x){x.onclick=function(){applyBinding(x.dataset.apply)}});$$('[data-delbind]').forEach(function(x){x.onclick=function(){deleteBinding(x.dataset.delbind)}});
  }
  async function resolveCurrent(){ctx.doc=getDoc();$('#hostState').textContent='已连接 WPS 演示';$('#docInfo').textContent=ctx.doc.name+' · '+ctx.doc.key;var r=await api('/api/resolve-project',{method:'POST',body:{documentKey:ctx.doc.key}});ctx.project=r.project;ctx.document=r.document;if(ctx.project){ctx.project=await fetchProject(ctx.project.id);updateProjectView(ctx.project)}else{updateProjectView(null);RA.renderFiles(null)}await render()}
  async function bindCurrentTo(id){if(!id)throw new Error('请选择项目');clearBindingPreview();var r=await api('/api/projects/'+id+'/documents',{method:'POST',body:ctx.doc});ctx.document=r.document;ctx.project=await fetchProject(id);updateProjectView(ctx.project);await render();toast('当前 PPT 已加入“'+ctx.project.name+'”')}
  async function createAndBind(){var name=$('#newProjectName').value.trim();if(!name)throw new Error('请输入项目名称');var r=await api('/api/projects',{method:'POST',body:{name:name}});await loadProjects();$('#projectSelect').value=r.project.id;await bindCurrentTo(r.project.id);$('#newProjectName').value='';$('#newProjectRow').classList.remove('show')}
  async function previewSelectedProject(){var id=$('#projectSelect').value;clearBindingPreview();if(!id){if(!ctx.project)RA.renderFiles(null);return}try{RA.renderFiles(await fetchProject(id))}catch(e){}}
  function findSlide(target){
    var slides=ctx.app.ActivePresentation.Slides;if(target.slideId){try{if(typeof slides.FindBySlideID==='function'){var s=slides.FindBySlideID(target.slideId);if(s)return s}}catch(e){}try{for(var i=1;i<=slides.Count;i++){var x=slides.Item(i);if(Number(x.SlideID)===Number(target.slideId))return x}}catch(e){}}
    if(target.slideIndex)return slides.Item(target.slideIndex);throw new Error('找不到目标幻灯片');
  }
  function findShape(target){var slide=findSlide(target);for(var i=1;i<=slide.Shapes.Count;i++){var s=slide.Shapes.Item(i);if(Number(s.Id)===Number(target.shapeId))return s}throw new Error('找不到目标对象：第 '+target.slideIndex+' 页 '+target.shapeName)}
  function preflightPlanToShape(shape,plan){
    if(plan.kind==='text'){try{if(!shape.TextFrame||!shape.TextFrame.TextRange)throw new Error('目标没有文本框能力');return}catch(e){throw new Error('目标文本框不可写入：'+e.message)}}
    if(plan.kind==='table'){
      var table=null;try{table=shape.Table}catch(e){}if(!table)throw new Error('目标对象不是表格');var cols=(plan.header&&plan.header.length)||(plan.rows&&plan.rows[0]&&plan.rows[0].length)||0;if(table.Columns.Count<cols)throw new Error('目标表格只有 '+table.Columns.Count+' 列，但渲染计划需要 '+cols+' 列');return;
    }
    throw new Error('不支持的渲染计划：'+plan.kind);
  }
  function applyPlanToShape(shape,plan){
    preflightPlanToShape(shape,plan);
    if(plan.kind==='text'){try{shape.TextFrame.TextRange.Text=String(plan.text==null?'':plan.text);return}catch(e){throw new Error('目标文本框写入失败：'+e.message)}}
    if(plan.kind==='table'){
      var table=shape.Table,desired=(plan.header?1:0)+(plan.rows||[]).length;if(plan.resizeRows){try{while(table.Rows.Count<desired)table.Rows.Add();while(table.Rows.Count>Math.max(desired,1))table.Rows.Item(table.Rows.Count).Delete()}catch(e){throw new Error('调整表格行数失败：'+e.message)}}
      var rr=1;if(plan.header){for(var c=0;c<plan.header.length;c++)table.Cell(rr,c+1).Shape.TextFrame.TextRange.Text=String(plan.header[c]==null?'':plan.header[c]);rr++}
      (plan.rows||[]).forEach(function(row){for(var c=0;c<row.length;c++)table.Cell(rr,c+1).Shape.TextFrame.TextRange.Text=String(row[c]==null?'':row[c]);rr++});return;
    }
  }
  async function applyBinding(id){
    var traceId=RA.makeTraceId();try{
      var r=await api('/api/projects/'+ctx.project.id+'/bindings/'+id+'/plan'),shape=findShape(r.binding.target);preflightPlanToShape(shape,r.plan);applyPlanToShape(shape,r.plan);
      await RA.trace({traceId:traceId,projectId:ctx.project.id,component:'wps-wpp',stage:'apply',action:'apply-existing-binding',status:'ok',sensitive:true,data:{bindingId:id,target:r.binding.target,plan:r.plan}});$('#planPreview').innerHTML='<div class="preview-card"><div class="preview-head"><strong>最近一次刷新</strong><span class="status-pill ok">已应用</span></div><details open><summary class="muted">渲染计划</summary><div class="mono">'+esc(JSON.stringify(r.plan,null,2))+'</div></details></div>';toast('已应用到 PPT');
    }catch(e){await RA.trace({traceId:traceId,projectId:ctx.project&&ctx.project.id,component:'wps-wpp',stage:'apply',action:'apply-existing-binding',status:'error',message:e.message});toast(e.message,'err');throw e}
  }
  async function deleteBinding(id){try{await api('/api/projects/'+ctx.project.id+'/bindings/'+id,{method:'DELETE'});toast('绑定已删除');await render()}catch(e){toast(e.message,'err')}}

  function clearBindingPreview(){ctx.bindingDraft=null;var box=$('#planPreview');if(box)box.innerHTML=''}
  function renderBindingPreview(r){
    ctx.bindingDraft=r;var repairs=Math.max(0,(r.attempts||[]).filter(function(x){return x.via==='ai'}).length-1),gen=r.generation==='ai-dynamic'?'AI 临时能力':(r.generation==='ai'?'AI 规则':'内置规则'),repairText=repairs?(' · 自动修复 '+repairs+' 次'):'';
    var plan=r.plan||{},summary=plan.kind==='text'?('将写入文本：'+String(plan.text==null?'':plan.text)):('将写入表格：'+((plan.rows||[]).length)+' 行数据');
    var critic=r.critic||{},issues=(critic.issues||[]),risk='';
    if(r.dynamicCapability){risk='<div class="risk-card"><strong>本次使用 AI 临时沙箱能力</strong><div class="muted">该程序已经通过能力图校验和无副作用快速试跑，但属于 AI 现场生成逻辑。请检查预览结果和程序后再确认。</div><label><input id="approveDynamicBinding" type="checkbox" style="width:auto"> 我已检查并确认本次临时能力，可以写入 PPT</label></div>'}
    $('#planPreview').innerHTML='<div class="preview-card"><div class="preview-head"><strong>绑定预览</strong><span class="status-pill ok">执行图 + 语义审查通过</span></div><div class="muted">'+esc(gen+repairText)+' · 还未修改 PPT</div><div class="preview-summary">'+esc(summary)+'</div>'+risk+'<details><summary class="muted">查看语义审查</summary><div class="mono">'+esc(JSON.stringify(critic,null,2))+'</div></details><details><summary class="muted">查看能力执行图 / 快速校验</summary><div class="mono">'+esc(JSON.stringify(r.graphValidation||{},null,2))+'</div></details><details><summary class="muted">查看 Renderer / 临时能力</summary><div class="mono">'+esc(JSON.stringify(r.renderer,null,2))+'</div></details><details><summary class="muted">查看渲染计划</summary><div class="mono">'+esc(JSON.stringify(r.plan,null,2))+'</div></details><div class="preview-actions"><button id="cancelBindingDraft">放弃预览</button><button id="confirmBindingDraft" class="primary"'+(r.dynamicCapability?' disabled':'')+'>确认应用到 PPT</button></div></div>';
    $('#cancelBindingDraft').onclick=clearBindingPreview;$('#confirmBindingDraft').onclick=applyBindingPreview;
    var ack=$('#approveDynamicBinding');if(ack)ack.onchange=function(){$('#confirmBindingDraft').disabled=!ack.checked};
  }
  async function createBindingPreview(){
    var traceId=(ctx.target&&ctx.target.traceId)||RA.makeTraceId();try{
      if(!ctx.project||!ctx.document)throw new Error('请先把当前 PPT 加入项目');if(!ctx.target)throw new Error('请先读取当前 PPT 选中对象');var variableId=$('#variableSelect').value;if(!variableId)throw new Error('请选择变量');
      clearBindingPreview();$('#createBinding').disabled=true;$('#createBinding').textContent='校验生成中…';var targetBody={kind:ctx.target.kind,slideId:ctx.target.slideId,slideIndex:ctx.target.slideIndex,shapeId:ctx.target.shapeId,shapeName:ctx.target.shapeName,hasTextFrame:ctx.target.hasTextFrame,snapshot:ctx.target.snapshot||null};
      var r=await api('/api/projects/'+ctx.project.id+'/bindings/preview',{method:'POST',body:{variableId:variableId,documentId:ctx.document.id,target:targetBody,description:$('#bindingDescription').value.trim(),traceId:traceId}});var shape=findShape(targetBody);preflightPlanToShape(shape,r.plan);renderBindingPreview(r);toast(r.generation==='ai'?'AI 绑定已生成并通过校验，请确认':'默认绑定已生成并通过校验，请确认');
    }catch(e){await RA.trace({traceId:traceId,projectId:ctx.project&&ctx.project.id,component:'wps-wpp',stage:'preview',action:'binding-preview',status:'error',message:e.message});toast(e.message,'err');clearBindingPreview()}
    finally{$('#createBinding').disabled=!(ctx.project&&ctx.target&&$('#variableSelect').value);$('#createBinding').textContent='生成绑定预览'}
  }
  async function applyBindingPreview(){
    if(!ctx.bindingDraft)return;var draft=ctx.bindingDraft,shape=null,committed=null,btn=$('#confirmBindingDraft');
    try{
      shape=findShape(ctx.target);preflightPlanToShape(shape,draft.plan);if(btn){btn.disabled=true;btn.textContent='应用中…'}
      var ack=$('#approveDynamicBinding');committed=await api('/api/projects/'+ctx.project.id+'/bindings/apply',{method:'POST',body:{draftId:draft.draftId,approveDynamicCapability:!draft.dynamicCapability||(ack&&ack.checked)}});
      try{applyPlanToShape(shape,committed.plan);try{shape.Tags.Add('REPORT_BINDING_ID',committed.binding.id)}catch(e){}}
      catch(applyErr){try{await api('/api/projects/'+ctx.project.id+'/bindings/'+committed.binding.id,{method:'DELETE'})}catch(rollbackErr){applyErr.message+='；同时绑定回滚失败：'+rollbackErr.message}throw applyErr}
      await RA.trace({traceId:committed.traceId||draft.traceId,projectId:ctx.project.id,component:'wps-wpp',stage:'apply',action:'apply-preview-binding',status:'ok',sensitive:true,data:{bindingId:committed.binding.id,target:committed.binding.target,plan:committed.plan}});toast('绑定已保存并应用到 PPT');clearBindingPreview();await render();
    }catch(e){await RA.trace({traceId:draft.traceId,projectId:ctx.project&&ctx.project.id,component:'wps-wpp',stage:'apply',action:'apply-preview-binding',status:'error',message:e.message});toast(e.message,'err');clearBindingPreview()}
  }
  async function refreshAll(){try{if(!ctx.project)throw new Error('当前 PPT 未加入项目');ctx.project=await fetchProject(ctx.project.id);var mine=(ctx.project.bindings||[]).filter(function(b){return b.documentId===ctx.document.id}),ok=0;for(var i=0;i<mine.length;i++){try{await applyBinding(mine[i].id);ok++}catch(e){}}toast('刷新完成：'+ok+'/'+mine.length)}catch(e){toast(e.message,'err')}}
  async function init(){RA.wireSettings(function(){return ctx.project&&ctx.project.id});await RA.loadSettings().catch(function(){});await RA.checkCore();ctx.app=RA.getApp('wpp');if(!ctx.app){$('#hostState').textContent='未连接 WPS';$('#hostBlock').classList.remove('hidden');return}$('#hostBlock').classList.add('hidden');try{await loadProjects();await resolveCurrent()}catch(e){$('#hostState').textContent='WPS 已连接';$('#docInfo').textContent=e.message;toast(e.message,'err')}}

  $('#toggleNewProject').onclick=function(){$('#newProjectRow').classList.toggle('show')};$('#createProject').onclick=function(){createAndBind().catch(function(e){toast(e.message,'err')})};$('#bindProject').onclick=function(){bindCurrentTo($('#projectSelect').value).catch(function(e){toast(e.message,'err')})};$('#projectSelect').onchange=previewSelectedProject;
  $('#captureTarget').onclick=async function(){try{clearBindingPreview();ctx.target=currentTarget();ctx.target.traceId=RA.makeTraceId();$('#targetInfo').textContent='第 '+ctx.target.slideIndex+' 页 · '+ctx.target.shapeName+' · '+ctx.target.kind;$('#createBinding').disabled=!(ctx.project&&$('#variableSelect').value);await RA.trace({traceId:ctx.target.traceId,projectId:ctx.project&&ctx.project.id,component:'wps-wpp',stage:'target',action:'capture-target',status:'ok',sensitive:false,data:{document:ctx.doc&&ctx.doc.name,target:ctx.target}});toast('已读取 PPT 目标对象')}catch(e){await RA.trace({traceId:ctx.target&&ctx.target.traceId,projectId:ctx.project&&ctx.project.id,component:'wps-wpp',stage:'target',action:'capture-target',status:'error',message:e.message});toast(e.message,'err')}};
  $('#variableSelect').onchange=function(){clearBindingPreview();$('#createBinding').disabled=!(ctx.project&&ctx.target&&$('#variableSelect').value)};$('#bindingDescription').oninput=clearBindingPreview;$('#createBinding').onclick=createBindingPreview;$('#refreshAll').onclick=refreshAll;$('#reload').onclick=function(){location.reload()};init().catch(function(e){toast(e.message,'err')});
})();
