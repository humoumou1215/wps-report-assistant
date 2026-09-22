(function(global){
  'use strict';
  var CORE = global.location && global.location.protocol === 'http:' && global.location.hostname === '127.0.0.1' ? global.location.origin : 'http://127.0.0.1:17891';
  var sessionToken='';
  var debugState={enabled:false,includeSourceData:false,maxEvents:2000};
  var agentState={criticEnabled:true,dynamicCapabilitiesEnabled:false};
  function $(s){return document.querySelector(s)}
  function $$(s){return Array.prototype.slice.call(document.querySelectorAll(s))}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function toast(msg,kind){var e=$('#toast');if(!e)return;e.textContent=msg;e.className=(kind==='err'?'err ':'')+'show';clearTimeout(e.__t);e.__t=setTimeout(function(){e.className=''},4200)}
  async function api(path,opts){opts=opts||{};var o={method:opts.method||'GET',headers:Object.assign({},opts.headers||{})};if(sessionToken)o.headers['X-RA-Token']=sessionToken;if(opts.body!==undefined){o.headers['Content-Type']='application/json';o.body=typeof opts.body==='string'?opts.body:JSON.stringify(opts.body)}var r=await fetch(CORE+path,o);var b={};try{b=await r.json()}catch(e){}if(!r.ok){var error=new Error(b.error||('HTTP '+r.status));error.code=b.code;throw error;}return b}
  async function agentPreview(path,body,onProgress){
    var initial=await api(path,{method:'POST',body:Object.assign({},body,{async:true})});
    if(!initial.draftId||initial.result||initial.plan)return initial;
    var draftPath=path.replace(/\/(variables|bindings)\/preview$/, '/drafts/'+initial.draftId).replace(/\/resume$/,''),stream=null;
    var labels={agent_started:'正在理解要求…',inspecting_source:'正在检查数据结构…',candidate_execution_started:'正在完整数据上执行…',candidate_execution_failed:'执行失败，AI 正在修复…',candidate_repairing:'正在根据复核意见修复…',candidate_validated:'规则验证通过…',critic_started:'正在进行语义复核…'};
    async function progress(runId){
      if(!window.ReadableStream)return;
      var r=await fetch(CORE+'/api/agent/runs/'+runId+'/events',{headers:{'X-RA-Token':sessionToken}});
      if(!r.ok||!r.body)return;stream=r.body.getReader();var decoder=new TextDecoder(),pending='';
      while(true){var chunk=await stream.read();if(chunk.done)break;pending+=decoder.decode(chunk.value,{stream:true});var blocks=pending.split('\n\n');pending=blocks.pop();blocks.forEach(function(block){var match=/^event: (.+)$/m.exec(block);if(match&&labels[match[1]]&&onProgress)onProgress(labels[match[1]])})}
    }
    var started=false;
    try{while(true){var draft=await api(draftPath);if(draft.runId&&!started){started=true;progress(draft.runId).catch(function(){})}if(draft.status==='preview_ready')return draft;if(['failed','cancelled','interrupted'].indexOf(draft.status)>=0)throw new Error(draft.error&&draft.error.message||'任务未完成，可重新生成');await new Promise(function(resolve){setTimeout(resolve,500)})}}
    finally{if(stream)stream.cancel().catch(function(){})}
  }
  function getApp(host){
    try{if(global.Application)return global.Application}catch(e){}
    try{if(global.wps){if(host==='wps'&&typeof global.wps.WpsApplication==='function')return global.wps.WpsApplication();if(host==='et'&&typeof global.wps.EtApplication==='function')return global.wps.EtApplication();if(host==='wpp'&&typeof global.wps.WppApplication==='function')return global.wps.WppApplication();if(global.wps.Application)return global.wps.Application}}catch(e){}
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
    try{var h=await api('/api/health');sessionToken=h.token||'';dot&&dot.classList.add('ok');dot&&dot.classList.remove('bad');if(text)text.textContent='Core '+h.version+' 已连接';return true}
    catch(e){dot&&dot.classList.add('bad');dot&&dot.classList.remove('ok');if(text)text.textContent='Core 未启动，请重新启动“数据报告助手”或重新登录系统';return false}
  }
  function makeTraceId(){return 'trace_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,9)}
  async function trace(evt){
    if(!debugState.enabled)return;
    evt=evt||{};
    try{await api('/api/debug/events',{method:'POST',body:evt})}catch(e){}
  }
  async function loadSettings(){
    var s=await api('/api/settings');var a=s.ai||{},d=s.debug||{},ag=s.agent||{};
    if($('#aiEnabled'))$('#aiEnabled').checked=!!a.enabled;
    if($('#aiBaseUrl'))$('#aiBaseUrl').value=a.baseUrl||'';
    if($('#aiModel'))$('#aiModel').value=a.model||'';
    if($('#aiKey')){$('#aiKey').value='';$('#aiKey').placeholder=a.apiKeyConfigured?'已配置，留空保留现有密钥':'请输入 API Key';}
    agentState.criticEnabled=ag.criticEnabled!==false;agentState.dynamicCapabilitiesEnabled=!!ag.dynamicCapabilitiesEnabled;
    if($('#criticEnabled'))$('#criticEnabled').checked=agentState.criticEnabled;
    if($('#dynamicCapabilitiesEnabled'))$('#dynamicCapabilitiesEnabled').checked=agentState.dynamicCapabilitiesEnabled;
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
    if(body.ai&&!body.ai.apiKey)delete body.ai.apiKey;
    if($('#debugEnabled'))body.debug={enabled:$('#debugEnabled').checked,includeSourceData:$('#debugIncludeData').checked,maxEvents:Number($('#debugMaxEvents').value||2000)};
    if($('#criticEnabled'))body.agent={criticEnabled:$('#criticEnabled').checked,dynamicCapabilitiesEnabled:$('#dynamicCapabilitiesEnabled').checked};
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
    if(save)save.onclick=async function(){try{var dyn=$('#dynamicCapabilitiesEnabled');if(dyn&&dyn.checked&&!agentState.dynamicCapabilitiesEnabled){var ok=global.confirm('高风险实验功能：允许 AI 在运行时创建临时沙箱能力。\n\n临时能力不能访问文件、网络、进程、注册表或 WPS COM，但它会参与数据计算/展示计划生成，错误程序可能产生错误报表数据。\n\n是否确认开启？');if(!ok){dyn.checked=false;return}}await saveSettings()}catch(e){toast(e.message,'err')}};
    var exp=$('#exportDiagnostics');if(exp)exp.onclick=async function(){try{await exportDiagnostics(getProjectId?getProjectId():'')}catch(e){toast(e.message,'err')}};
    var sample=$('#prepareSample');if(sample)sample.onclick=async function(){try{await prepareSample()}catch(e){toast(e.message,'err')}};
    var clear=$('#clearDiagnostics');if(clear)clear.onclick=async function(){try{await clearDiagnostics()}catch(e){toast(e.message,'err')}};
  }
  function renderFiles(project){
    var box=$('#projectFiles');if(!box)return;
    var docs=(project&&project.documents)||[];
    box.innerHTML=docs.length?docs.map(function(d){return '<div class="file"><span class="file-kind">'+({et:'表格',wpp:'演示',wps:'文字'}[d.kind]||'文件')+'</span><span title="'+esc(d.key)+'">'+esc(d.name||d.key)+'</span></div>'}).join(''):'<div class="muted">项目中还没有文件</div>';
  }
  global.RA={CORE:CORE,$:$,$$:$$,esc:esc,toast:toast,api:api,agentPreview:agentPreview,getApp:getApp,previewValue:previewValue,checkCore:checkCore,wireSettings:wireSettings,renderFiles:renderFiles,trace:trace,makeTraceId:makeTraceId,loadSettings:loadSettings,debugState:debugState,agentState:agentState,exportDiagnostics:exportDiagnostics,prepareSample:prepareSample};
})(window);
