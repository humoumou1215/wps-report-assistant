(function(){
  'use strict';
  var $=RA.$,$$=RA.$$,api=RA.api,toast=RA.toast,esc=RA.esc,previewValue=RA.previewValue;
  var ctx={app:null,doc:null,project:null,document:null,selection:null,projects:[],variableDraft:null};

  function normalizeValues(v){
    if(Array.isArray(v)){if(v.length===0)return [];return Array.isArray(v[0])?v:v.map(function(x){return [x]})}
    return [[v]];
  }
  function getDoc(){
    var app=ctx.app||RA.getApp('et');if(!app)throw new Error('没有检测到 WPS 表格宿主');
    var wb=app.ActiveWorkbook;if(!wb)throw new Error('没有活动工作簿');
    var full='',path='';try{full=String(wb.FullName||'').trim()}catch(e){}try{path=String(wb.Path||'').trim()}catch(e){}
    if(!path&&!/[\\/]/.test(full))throw new Error('请先保存当前 Excel 文件，再加入项目');
    var key=full||path+'/'+String(wb.Name||'');return {key:key,name:String(wb.Name||key),kind:'et'};
  }
  function getAddress(sel){try{return String(typeof sel.Address==='function'?sel.Address():sel.Address||'')}catch(e){return ''}}
  function readSelection(){
    var app=ctx.app,sel=app.Selection;if(!sel)throw new Error('没有选中区域');var sheet=app.ActiveSheet,values=normalizeValues(sel.Value2);
    if(values.length>5000)throw new Error('单次选区最多 5000 行，请缩小选区');
    return {sheetName:String(sheet&&sheet.Name||''),address:getAddress(sel),values:values,headersMode:'first-row'};
  }
  function selectionPreview(s){
    if(!s||!s.values||!s.values.length)return '<div class="empty">选区为空</div>';
    var vals=s.values,heads=vals[0].map(function(x,i){return String(x==null||x===''?'列'+(i+1):x)}),rows=vals.slice(1,9).map(function(r){var o={};heads.forEach(function(h,i){o[h]=r[i]});return o});
    return previewValue({valueType:'table',columns:heads,value:rows});
  }
  async function loadProjects(){var r=await api('/api/projects');ctx.projects=r.projects||[];$('#projectSelect').innerHTML='<option value="">选择项目…</option>'+ctx.projects.map(function(p){return '<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>'}).join('')}
  async function fetchProject(id){return (await api('/api/projects/'+id)).project}
  function updateProjectView(p){RA.renderFiles(p);$('#projectBadge').textContent=p?p.name:'未绑定项目';if(p)$('#projectSelect').value=p.id}
  async function renderVariables(){
    if(!ctx.project){$('#variables').innerHTML='<div class="empty">先把当前 Excel 加入项目</div>';$('#varCount').textContent='';return}
    ctx.project=await fetchProject(ctx.project.id);updateProjectView(ctx.project);var vars=ctx.project.variables||[];$('#varCount').textContent=vars.length+' 个';
    $('#variables').innerHTML=vars.length?vars.map(function(v){
      var src=ctx.project.sources.find(function(s){return s.id===v.sourceId}),doc=src&&ctx.project.documents.find(function(d){return d.id===src.documentId});
      return '<div class="item"><div class="item-title"><span>'+esc(v.displayName||v.name)+' <span class="badge">'+esc(v.valueType)+'</span></span><button class="danger" data-del="'+v.id+'">删除</button></div><div class="muted">来源：'+esc(doc&&doc.name||'')+(src?' · '+esc(src.sheetName)+'!'+esc(src.address):'')+'</div><div class="muted">'+esc(v.description||'')+'</div>'+previewValue(v)+'<details><summary class="muted">查看计算规则</summary><div class="mono">'+esc(JSON.stringify(v.transform,null,2))+'</div></details><div class="row" style="margin-top:6px"><button data-refresh="'+v.id+'">从来源 Excel 刷新并重算</button></div></div>';
    }).join(''):'<div class="empty">这个项目还没有变量</div>';
    $$('[data-refresh]').forEach(function(b){b.onclick=function(){refreshVariable(b.dataset.refresh)}});$$('[data-del]').forEach(function(b){b.onclick=function(){deleteVariable(b.dataset.del)}});
  }
  async function resolveCurrent(){
    ctx.doc=getDoc();$('#hostState').textContent='已连接 WPS 表格';$('#docInfo').textContent=ctx.doc.name+' · '+ctx.doc.key;
    var r=await api('/api/resolve-project',{method:'POST',body:{documentKey:ctx.doc.key}});ctx.project=r.project;ctx.document=r.document;
    if(ctx.project){ctx.project=await fetchProject(ctx.project.id);updateProjectView(ctx.project)}else{updateProjectView(null);RA.renderFiles(null)}await renderVariables();
  }
  async function bindCurrentTo(id){
    if(!id)throw new Error('请选择项目');clearVariablePreview();var r=await api('/api/projects/'+id+'/documents',{method:'POST',body:ctx.doc});ctx.document=r.document;ctx.project=await fetchProject(id);updateProjectView(ctx.project);await renderVariables();toast('当前 Excel 已加入“'+ctx.project.name+'”');
  }
  async function createAndBind(){var name=$('#newProjectName').value.trim();if(!name)throw new Error('请输入项目名称');var r=await api('/api/projects',{method:'POST',body:{name:name}});await loadProjects();$('#projectSelect').value=r.project.id;await bindCurrentTo(r.project.id);$('#newProjectName').value='';$('#newProjectRow').classList.remove('show')}
  async function refreshVariable(id){
    try{
      ctx.project=await fetchProject(ctx.project.id);var v=ctx.project.variables.find(function(x){return x.id===id}),src=ctx.project.sources.find(function(x){return x.id===v.sourceId});
      if(!src)throw new Error('变量数据源不存在');if(src.documentId!==ctx.document.id)throw new Error('这个变量来自项目中的另一份 Excel，请打开 '+(ctx.project.documents.find(function(d){return d.id===src.documentId})||{}).name+' 后刷新');
      var wb=ctx.app.ActiveWorkbook,ws=wb.Worksheets.Item(src.sheetName),range=ws.Range(src.address),values=normalizeValues(range.Value2);
      await api('/api/projects/'+ctx.project.id+'/sources/'+src.id,{method:'PATCH',body:{values:values}});await api('/api/projects/'+ctx.project.id+'/variables/'+id+'/recompute',{method:'POST',body:{}});toast('变量已刷新');await renderVariables();
    }catch(e){toast(e.message,'err')}
  }
  async function deleteVariable(id){try{await api('/api/projects/'+ctx.project.id+'/variables/'+id,{method:'DELETE'});toast('变量已删除');await renderVariables()}catch(e){toast(e.message,'err')}}

  function clearVariablePreview(){ctx.variableDraft=null;var box=$('#variableDraftPreview');if(box)box.innerHTML=''}
  function renderVariablePreview(r){
    ctx.variableDraft=r;var result=r.result||{},repairs=Math.max(0,(r.attempts||[]).length-1),gen=r.generation==='ai'?'AI 规则':'内置规则';
    var repairText=repairs?(' · 自动修复 '+repairs+' 次'):'';
    $('#variableDraftPreview').innerHTML='<div class="preview-card"><div class="preview-head"><strong>变量预览</strong><span class="status-pill ok">校验通过</span></div><div class="muted">'+esc(gen+repairText)+' · 还未写入项目</div>'+previewValue({valueType:result.valueType,columns:result.columns||[],value:result.value})+'<details><summary class="muted">查看将要保存的计算规则</summary><div class="mono">'+esc(JSON.stringify(r.transform,null,2))+'</div></details><div class="preview-actions"><button id="cancelVariableDraft">放弃预览</button><button id="confirmVariableDraft" class="primary">确认创建变量</button></div></div>';
    $('#cancelVariableDraft').onclick=clearVariablePreview;$('#confirmVariableDraft').onclick=applyVariablePreview;
  }
  async function capture(){
    try{
      clearVariablePreview();ctx.selection=readSelection();ctx.selection.traceId=RA.makeTraceId();$('#selectionInfo').textContent=ctx.selection.sheetName+'!'+ctx.selection.address;$('#selectionPreview').innerHTML=selectionPreview(ctx.selection);$('#generate').disabled=!ctx.project;
      var rows=ctx.selection.values.length,cols=(rows&&ctx.selection.values[0]&&ctx.selection.values[0].length)||0;
      await RA.trace({traceId:ctx.selection.traceId,projectId:ctx.project&&ctx.project.id,component:'wps-et',stage:'selection',action:'capture-selection',status:'ok',sensitive:true,data:{document:ctx.doc&&ctx.doc.name,sheetName:ctx.selection.sheetName,address:ctx.selection.address,rows:rows,cols:cols,values:ctx.selection.values}});toast('已读取当前选区');
    }catch(e){await RA.trace({traceId:ctx.selection&&ctx.selection.traceId,projectId:ctx.project&&ctx.project.id,component:'wps-et',stage:'selection',action:'capture-selection',status:'error',message:e.message});toast(e.message,'err')}
  }
  async function generatePreview(){
    try{
      if(!ctx.project||!ctx.document)throw new Error('请先把当前 Excel 加入项目');if(!ctx.selection)throw new Error('请先读取当前选区');var name=$('#varName').value.trim();if(!name)throw new Error('请输入变量名');
      clearVariablePreview();$('#generate').disabled=true;$('#generate').textContent='校验生成中…';var traceId=ctx.selection.traceId||RA.makeTraceId();
      var r=await api('/api/projects/'+ctx.project.id+'/variables/preview',{method:'POST',body:{documentId:ctx.document.id,sheetName:ctx.selection.sheetName,address:ctx.selection.address,values:ctx.selection.values,headersMode:'first-row',name:name,displayName:name,description:$('#description').value.trim(),traceId:traceId}});
      renderVariablePreview(r);toast(r.generation==='ai'?'AI 规则已生成并通过校验，请确认':'内置规则已生成并通过校验，请确认');
    }catch(e){await RA.trace({traceId:ctx.selection&&ctx.selection.traceId,projectId:ctx.project&&ctx.project.id,component:'wps-et',stage:'preview',action:'variable-preview',status:'error',message:e.message});toast(e.message,'err')}
    finally{$('#generate').disabled=!(ctx.project&&ctx.selection);$('#generate').textContent='生成变量预览'}
  }
  async function applyVariablePreview(){
    if(!ctx.variableDraft)return;
    var draft=ctx.variableDraft,btn=$('#confirmVariableDraft');
    try{
      if(btn){btn.disabled=true;btn.textContent='保存中…'}var r=await api('/api/projects/'+ctx.project.id+'/variables/apply',{method:'POST',body:{draftId:draft.draftId}});
      await RA.trace({traceId:r.traceId||draft.traceId,projectId:ctx.project.id,component:'wps-et',stage:'apply',action:'variable-saved',status:'ok',sensitive:false,data:{variableId:r.variable&&r.variable.id,name:r.variable&&r.variable.name,generation:r.generation}});
      toast('变量已创建');$('#varName').value='';$('#description').value='';clearVariablePreview();await renderVariables();
    }catch(e){await RA.trace({traceId:draft.traceId,projectId:ctx.project&&ctx.project.id,component:'wps-et',stage:'apply',action:'variable-save',status:'error',message:e.message});toast(e.message,'err');clearVariablePreview()}
  }
  async function previewSelectedProject(){var id=$('#projectSelect').value;clearVariablePreview();if(!id){if(!ctx.project)RA.renderFiles(null);return}try{RA.renderFiles(await fetchProject(id))}catch(e){}}
  async function init(){
    RA.wireSettings(function(){return ctx.project&&ctx.project.id});await RA.loadSettings().catch(function(){});await RA.checkCore();ctx.app=RA.getApp('et');if(!ctx.app){$('#hostState').textContent='未连接 WPS';$('#hostBlock').classList.remove('hidden');return}
    $('#hostBlock').classList.add('hidden');try{await loadProjects();await resolveCurrent()}catch(e){$('#hostState').textContent='WPS 已连接';$('#docInfo').textContent=e.message;toast(e.message,'err')}
  }
  $('#toggleNewProject').onclick=function(){$('#newProjectRow').classList.toggle('show')};$('#createProject').onclick=function(){createAndBind().catch(function(e){toast(e.message,'err')})};$('#bindProject').onclick=function(){bindCurrentTo($('#projectSelect').value).catch(function(e){toast(e.message,'err')})};$('#projectSelect').onchange=previewSelectedProject;
  $('#capture').onclick=capture;$('#generate').onclick=generatePreview;$('#reload').onclick=function(){location.reload()};
  $('#varName').oninput=clearVariablePreview;$('#description').oninput=clearVariablePreview;
  init().catch(function(e){toast(e.message,'err')});
})();
