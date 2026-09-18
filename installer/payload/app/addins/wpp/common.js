(function(global){
  'use strict';
  var CORE = 'http://127.0.0.1:17891';
  var debugState={enabled:false,includeSourceData:false,maxEvents:2000};
  function $(s){return document.querySelector(s)}
  function $$(s){return Array.prototype.slice.call(document.querySelectorAll(s))}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function toast(msg,kind){var e=$('#toast');if(!e)return;e.textContent=msg;e.className=(kind==='err'?'err ':'')+'show';clearTimeout(e.__t);e.__t=setTimeout(function(){e.className=''},4200)}
  async function api(path,opts){opts=opts||{};var o={method:opts.method||'GET',headers:Object.assign({},opts.headers||{})};if(opts.body!==undefined){o.headers['Content-Type']='application/json';o.body=typeof opts.body==='string'?opts.body:JSON.stringify(opts.body)}var r=await fetch(CORE+path,o);var b={};try{b=await r.json()}catch(e){}if(!r.ok)throw new Error(b.error||('HTTP '+r.status));return b}
  function getApp(host){
    try{if(global.Application)return global.Application}catch(e){}
    try{if(global.wps){if(host==='et'&&typeof global.wps.EtApplication==='function')return global.wps.EtApplication();if(host==='wpp'&&typeof global.wps.WppApplication==='function')return global.wps.WppApplication();if(global.wps.Application)return global.wps.Application}}catch(e){}
    return null;
  }
  function previewValue(v){
    if(!v)return '<div class="empty">无结果</div>';
    if(v.valueType==='table'){
      var rows=Array.isArray(v.value)?v.value:[];var cols=v.columns||[];
      return '<div class="tablewrap"><table><thead><tr>'+cols.map(function(c){return '<th>'+esc(c)+'</th>'}).join('')+'</tr></thead><tbody>'+rows.slice(0,20).map(function(r){return '<tr>'+cols.map(function(c){return '<td>'+esc(r&&r[c])+'</td>'}).join('')+'</tr>'}).join('')+'</tbody></table></div><div class="muted">'+rows.length+' 行'+(rows.length>20?'（预览前20行）':'')+'</div>';
    }
    return '<div class="mono">'+esc(v.value)+'</div>';
  }
  async function checkCore(){
    var dot=$('#coreDot'),text=$('#coreState');
    try{var h=await api('/api/health');dot&&dot.classList.add('ok');dot&&dot.classList.remove('bad');if(text)text.textContent='Core '+h.version+' 已连接';return true}
    catch(e){dot&&dot.classList.add('bad');dot&&dot.classList.remove('ok');if(text)text.textContent='Core 未启动，请重新启动“数据报告助手”或重新登录 Windows';return false}
  }
  function makeTraceId(){return 'trace_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,9)}
  async function trace(evt){
    if(!debugState.enabled)return;
    evt=evt||{};
    try{await api('/api/debug/events',{method:'POST',body:evt})}catch(e){}
  }
  async function loadSettings(){
    var s=await api('/api/settings');var a=s.ai||{},d=s.debug||{};
    if($('#aiEnabled'))$('#aiEnabled').checked=!!a.enabled;
    if($('#aiBaseUrl'))$('#aiBaseUrl').value=a.baseUrl||'';
    if($('#aiModel'))$('#aiModel').value=a.model||'';
    if($('#aiKey'))$('#aiKey').value=a.apiKey||'';
    debugState.enabled=!!d.enabled;debugState.includeSourceData=!!d.includeSourceData;debugState.maxEvents=d.maxEvents||2000;
    if($('#debugEnabled'))$('#debugEnabled').checked=debugState.enabled;
    if($('#debugIncludeData'))$('#debugIncludeData').checked=debugState.includeSourceData;
    if($('#debugMaxEvents'))$('#debugMaxEvents').value=debugState.maxEvents;
    var badge=$('#debugBadge');if(badge){badge.textContent=debugState.enabled?'调试已开启':'调试关闭';badge.className='badge '+(debugState.enabled?'warn':'')}
    return s;
  }
  async function saveSettings(){
    var body={};
    if($('#aiEnabled'))body.ai={enabled:$('#aiEnabled').checked,baseUrl:$('#aiBaseUrl').value.trim(),model:$('#aiModel').value.trim(),apiKey:$('#aiKey').value.trim()};
    if($('#debugEnabled'))body.debug={enabled:$('#debugEnabled').checked,includeSourceData:$('#debugIncludeData').checked,maxEvents:Number($('#debugMaxEvents').value||2000)};
    await api('/api/settings',{method:'POST',body:body});await loadSettings();toast('设置已保存');
  }
  async function exportDiagnostics(projectId){
    if(!projectId)throw new Error('请先打开并加入一个项目');
    var r=await api('/api/diagnostics/export',{method:'POST',body:{projectId:projectId,includeSourceData:$('#debugIncludeData')?$('#debugIncludeData').checked:debugState.includeSourceData}});
    toast('诊断包已导出：'+r.filename);
    var p=$('#diagnosticPath');if(p)p.textContent=r.path||r.filename;
    return r;
  }
  async function prepareSample(){
    var r=await api('/api/debug/prepare-sample',{method:'POST',body:{}});toast('标准测试项目已准备，文件夹已打开');return r;
  }
  async function clearDiagnostics(){await api('/api/debug/clear',{method:'POST',body:{}});toast('诊断日志已清空')}
  function wireSettings(getProjectId){
    var btn=$('#settingsBtn'),panel=$('#settingsPanel'),close=$('#closeSettings'),save=$('#saveSettings');
    if(btn)btn.onclick=async function(){panel.classList.toggle('show');if(panel.classList.contains('show')){try{await loadSettings()}catch(e){toast(e.message,'err')}}};
    if(close)close.onclick=function(){panel.classList.remove('show')};
    if(save)save.onclick=async function(){try{await saveSettings()}catch(e){toast(e.message,'err')}};
    var exp=$('#exportDiagnostics');if(exp)exp.onclick=async function(){try{await exportDiagnostics(getProjectId?getProjectId():'')}catch(e){toast(e.message,'err')}};
    var sample=$('#prepareSample');if(sample)sample.onclick=async function(){try{await prepareSample()}catch(e){toast(e.message,'err')}};
    var clear=$('#clearDiagnostics');if(clear)clear.onclick=async function(){try{await clearDiagnostics()}catch(e){toast(e.message,'err')}};
  }
  function renderFiles(project){
    var box=$('#projectFiles');if(!box)return;
    var docs=(project&&project.documents)||[];
    box.innerHTML=docs.length?docs.map(function(d){return '<div class="file"><span class="file-kind">'+(d.kind==='et'?'XLSX':'PPT')+'</span><span title="'+esc(d.key)+'">'+esc(d.name||d.key)+'</span></div>'}).join(''):'<div class="muted">项目中还没有文件</div>';
  }
  global.RA={CORE:CORE,$:$,$$:$$,esc:esc,toast:toast,api:api,getApp:getApp,previewValue:previewValue,checkCore:checkCore,wireSettings:wireSettings,renderFiles:renderFiles,trace:trace,makeTraceId:makeTraceId,loadSettings:loadSettings,debugState:debugState,exportDiagnostics:exportDiagnostics,prepareSample:prepareSample};
})(window);
