(function(global){
  'use strict';
  var $=RA.$,$$=RA.$$,esc=RA.esc,api=RA.api;
  var state={project:null,document:null,conversation:null,references:[],drafts:{},bridgeKey:null,bridgeRunning:false,bridgeReady:null,sourceMonitorTimer:null,sourceMonitorBusy:false};
  function rememberDraft(){if(!state.conversation)return;state.drafts[state.conversation.id]={text:$('#conversationInput').value,references:JSON.parse(JSON.stringify(state.references))}}
  function restoreDraft(){var draft=state.conversation&&state.drafts[state.conversation.id];$('#conversationInput').value=draft&&draft.text||'';state.references=draft&&draft.references||[]}
  function hostDocument(){var id=new URLSearchParams(location.search).get('host')||'wps';return RAHosts.hosts[id].document()}
  function show(){
    if(global.RAWorkspace)global.RAWorkspace.view('conversation',true);
    $$('[data-view]').forEach(function(x){x.classList.toggle('hidden',x.dataset.view!=='conversation')});
    $('#viewConversation').classList.add('nav-active');['viewData','viewSettings'].forEach(function(id){var x=$('#'+id);if(x)x.classList.remove('nav-active')});
  }
  function renderMessages(messages,tasks){
    var box=$('#conversationMessages');
    box.innerHTML=messages.length?messages.map(function(m){return '<article class="chat-message '+esc(m.role)+'"><div class="chat-role">'+(m.role==='user'?'你':m.role==='assistant'?'助手':'系统')+'</div><div class="chat-text">'+esc(m.text)+'</div>'+(m.references&&m.references.length?'<div class="chat-refs">'+m.references.map(function(r){return '<span class="entity-chip">@'+esc(r.displayName||r.variableId||r.documentId||r.renderId)+'</span>'}).join('')+'</div>':'')+'</article>'}).join(''):'<div class="empty">告诉助手你要完成什么，它会先读取项目事实，再生成可验证的任务。</div>';
    var recent=(tasks||[]).slice(-5);if(recent.length)box.innerHTML+=recent.map(function(task){var label=task.status==='waiting_user'?'等待你确认':task.status==='completed'?'已完成':task.status==='failed'?'未完成':task.status==='verifying'?'验证实际修改':task.status==='rendering'?'通过安全网关修改文件':'分析并执行任务';var operations=(task.operations||[]).map(function(op){var name=op.type==='render'?(op.target&&op.target.label||op.documentId):op.name||((op.type==='update-variable'?'更新变量':'创建变量'));var status=op.confirmationRequired?'待确认':op.status==='applied'?'已验证':op.status==='failed'?'失败':op.status==='running'?'进行中':'已准备';var preview=op.changePreview?(op.changePreview.kind==='text'?'<div class="task-change-preview">'+esc(op.changePreview.preview||'')+'</div>':'<div class="task-change-preview">'+esc(op.changePreview.rowCount||0)+' 行 · '+esc(op.changePreview.columnCount||0)+' 列</div>'):'';return '<div class="task-operation"><span>'+esc(status)+' · '+esc(name)+'</span>'+preview+(op.confirmationRequired?'<button class="primary" data-confirm-operation="'+esc(op.id)+'" data-task-id="'+esc(task.id)+'">确认执行</button>':'')+'</div>'}).join('');return '<div class="task-progress" role="status"><strong>'+esc(label)+'</strong><div class="muted">'+esc(task.validation&&task.validation.errors&&task.validation.errors[0]||'')+'</div>'+operations+'</div>'}).join('');
    $$('[data-confirm-operation]').forEach(function(button){button.onclick=function(){confirmOperation(button.dataset.taskId,button.dataset.confirmOperation).catch(function(error){RA.toast(error.message,'err')})}});
    box.scrollTop=box.scrollHeight;
  }
  async function resolve(){
    state.document=hostDocument();
    var r=await api('/api/resolve-project',{method:'POST',body:{documentKey:state.document.key}});
    state.project=r.project;state.document=r.document;
    if(!state.project){$('#conversationMessages').innerHTML='<div class="empty">请先在“项目与文件”中加入当前文件。</div>';return false}
    await startBridge();
    $('#conversationProject').textContent=state.project.name+' · '+state.document.name;
    var list=await api('/api/projects/'+state.project.id+'/conversations');
    var conversations=list.conversations||[];
    state.conversation=(state.conversation&&conversations.find(function(item){return item.id===state.conversation.id}))||conversations[0];
    if(!state.conversation)state.conversation=(await api('/api/projects/'+state.project.id+'/conversations',{method:'POST',body:{title:'新的工作会话'}})).conversation;
    $('#conversationSelect').innerHTML=conversations.concat(conversations.some(function(item){return item.id===state.conversation.id})?[]:[state.conversation]).map(function(item){return '<option value="'+esc(item.id)+'">'+esc(item.title)+'</option>'}).join('');
    $('#conversationSelect').value=state.conversation.id;
    return true;
  }
  async function bridgeLoop(project,document,host,ready){
    await ready;
    while(state.bridgeKey===document.key){
      try{
        await api('/api/wps/bridge/register',{method:'POST',body:{projectId:project.id,documentId:document.id,documentKey:document.key,capabilities:RAHosts.forHost(host).map(function(c){return c.id})}});
        var response=await api('/api/wps/bridge/next?documentId='+encodeURIComponent(document.id)),command=response.command;
        if(!command)continue;
        try{
          if(hostDocument().key!==document.key)throw new Error('当前文件已切换，拒绝执行原文件操作');
          var adapter=RAHosts.capability(command.target.capabilityId),wrapped=RAHosts.resolve(command.target),result;
          if(command.action==='capture')result=RAChangeState.capture(wrapped);
          else if(command.action==='read')result=Object.assign({},adapter.read(command.target.locator||command.target),{snapshot:RAChangeState.capture(wrapped)});
          else if(command.action==='inspect'){result=RAHosts.hosts[host].inspect();(result.targets||[]).forEach(function(target){target.documentId=document.id})}
          else if(command.action==='apply'){RAChangeState.preflight(wrapped,command.plan);RAChangeState.apply(wrapped,command.plan);result=true;}
          else if(command.action==='restore'){RAChangeState.restore(wrapped,command.snapshot);result=true;}
          else throw new Error('未知 WPS 操作');
          await api('/api/wps/bridge/result',{method:'POST',body:{documentId:document.id,requestId:command.requestId,result:result}});
        }catch(error){await api('/api/wps/bridge/result',{method:'POST',body:{documentId:document.id,requestId:command.requestId,error:String(error&&error.message||error)}}).catch(function(){});}
      }catch(error){await new Promise(function(resolve){setTimeout(resolve,1000)});}
    }
  }
  function startBridge(){if(!state.project||!state.document)return Promise.resolve();var hostID=new URLSearchParams(location.search).get('host')||'wps',key=state.document.key;if(state.bridgeKey===key&&state.bridgeReady){startSourceMonitor();return state.bridgeReady}state.bridgeKey=key;state.bridgeRunning=true;var project=state.project,document=state.document;state.bridgeReady=api('/api/wps/bridge/register',{method:'POST',body:{projectId:project.id,documentId:document.id,documentKey:document.key,capabilities:RAHosts.forHost(hostID).map(function(c){return c.id})}});bridgeLoop(project,document,hostID,state.bridgeReady).finally(function(){if(state.bridgeKey===key)state.bridgeRunning=false});startSourceMonitor();return state.bridgeReady}
  function canonical(value){return JSON.stringify(value,function(k,v){if(v&&typeof v==='object'&&!Array.isArray(v)){var out={};Object.keys(v).sort().forEach(function(key){out[key]=v[key]});return out}return v})}
  async function refreshChangedSources(){
    if(state.sourceMonitorBusy||!state.project||!state.document)return;state.sourceMonitorBusy=true;
    try{
      var settings=await api('/api/settings');if(settings.automation&&settings.automation.autoRefreshVariables===false)return;
      var doc=hostDocument();if(doc.key!==state.document.key)return;
      var response=await api('/api/projects/'+state.project.id),project=response.project;
      var sources=(project.sources||[]).filter(function(source){return source.documentId===state.document.id&&source.capabilityId&&source.locator});
      for(var i=0;i<sources.length;i++){
        if(hostDocument().key!==state.document.key)break;
        var source=sources[i];try{
          var adapter=RAHosts.capability(source.capabilityId),read=adapter.read(source.locator),values=read&&read.values;
          if(!Array.isArray(values)||canonical(values)===canonical(source.values))continue;
          await api('/api/projects/'+state.project.id+'/sources/'+encodeURIComponent(source.id),{method:'PATCH',body:{values:values}});
          RA.toast('源数据已变化，相关变量已在本地重算；文档输出未自动修改');
        }catch(error){if(error&&error.code)RA.toast('源数据重算需要处理：'+error.message,'err')}
      }
      if(global.RAWorkspace&&global.RAWorkspace.refresh)await global.RAWorkspace.refresh();
    }catch(error){}finally{state.sourceMonitorBusy=false}
  }
  function startSourceMonitor(){if(state.sourceMonitorTimer)return;state.sourceMonitorTimer=setInterval(refreshChangedSources,15000);setTimeout(refreshChangedSources,2000)}
  async function selectionReference(){
    if(!state.project||!state.document)throw new Error('请先加入当前文件');
    var hostID=new URLSearchParams(location.search).get('host')||'wps',caps=RAHosts.forHost(hostID),candidate;
    for(var i=0;i<caps.length;i++){try{candidate=caps[i].selection();if(candidate)break}catch(e){}}
    if(!candidate)throw new Error('请先在当前文件中选择一个数据区域或对象');
    candidate.documentId=state.document.id;
    var adapter=RAHosts.capability(candidate.capabilityId),wrapped=RAHosts.resolve(candidate),snapshot=RAChangeState.capture(wrapped),source=adapter.read(candidate.locator||candidate);
    function canonical(value){return JSON.stringify(value,function(k,v){if(v&&typeof v==='object'&&!Array.isArray(v)){var out={};Object.keys(v).sort().forEach(function(key){out[key]=v[key]});return out}return v})}
    if(!global.crypto||!global.crypto.subtle)throw new Error('当前 WPS 不支持选区指纹，请更新 WPS 后重试');
    var bytes=new TextEncoder().encode(canonical(snapshot)),digest=await global.crypto.subtle.digest('SHA-256',bytes),fingerprint=Array.prototype.map.call(new Uint8Array(digest),function(b){return b.toString(16).padStart(2,'0')}).join('');
    return {type:'ephemeral-selection',documentId:state.document.id,target:candidate,fingerprint:fingerprint,capturedAt:new Date().toISOString(),displayName:state.document.name+' · '+(candidate.label||'当前选区'),values:source.values};
  }
  async function load(){if(!await resolve())return;var data=await api('/api/projects/'+state.project.id+'/conversations/'+state.conversation.id);$('#conversationTitle').textContent=state.conversation.title;renderMessages(data.messages||[],data.tasks||[]);loadTimeline().catch(function(){});loadReferences().catch(function(){})}
  async function loadTimeline(){if(!state.project)return;var settings=await api('/api/settings'),query=settings.ui&&settings.ui.timelineScope==='project'?'':'&documentId='+encodeURIComponent(state.document.id),r=await api('/api/projects/'+state.project.id+'/render-records?limit=8'+query);var box=$('#renderTimeline');box.innerHTML=(r.records||[]).map(function(x){var mark=x.action==='undo'?'↶':x.status==='verified'?'✓':x.status==='verifying'?'…':'⚠';return '<button class="timeline-item" data-render-id="'+esc(x.id)+'">'+mark+' '+esc(x.target&&x.target.label||x.documentId)+'</button>'}).join('');$$('[data-render-id]').forEach(function(b){b.onclick=function(){if(global.RAWorkspace){global.RAWorkspace.view('history',true);global.RAWorkspace.history.load().catch(function(e){RA.toast(e.message,'err')})}}})}
  async function loadReferences(query){if(!state.project)return;var r=await api('/api/projects/'+state.project.id+'/references?q='+encodeURIComponent(query||''));var items=(r.variables||[]).slice(0,8).map(function(x){return '<button class="entity-chip reference-button" data-ref-type="variable" data-ref-id="'+esc(x.variableId)+'" data-reference-name="'+esc(x.displayName)+'">@'+esc(x.displayName)+'</button>'}).concat((r.documents||[]).slice(0,8).map(function(x){return '<button class="entity-chip reference-button" data-ref-type="document" data-ref-id="'+esc(x.documentId)+'" data-reference-name="'+esc(x.displayName)+'">@'+esc(x.displayName)+'</button>'})).concat((r.renders||[]).slice(0,8).map(function(x){return '<button class="entity-chip reference-button" data-ref-type="render-record" data-ref-id="'+esc(x.id)+'" data-reference-name="'+esc(x.displayName||x.id)+'">@'+esc(x.displayName||x.id)+'</button>'}));
    var extras=[];if(!query||'当前文件'.indexOf(query)>=0)extras.push('<button class="entity-chip reference-button" data-ref-type="current-document" data-reference-name="'+esc(state.document.name)+'">@当前文件</button>');if(!query||'当前选区'.indexOf(query)>=0)extras.push('<button class="entity-chip reference-button" data-ref-type="current-selection" data-reference-name="当前选区">@当前选区</button>');
    $('#referenceChips').innerHTML='<div class="reference-picker">'+items.join('')+extras.join('')+(items.length||extras.length?'':'<span class="muted">没有匹配的引用对象</span>')+'</div><div class="selected-references">'+state.references.map(function(x,i){return '<button class="entity-chip" data-remove-ref="'+i+'">@'+esc(x.displayName||x.variableId||x.documentId||x.renderId)+' ×</button>'}).join('')+'</div>';
    $$('[data-ref-type]').forEach(function(b){b.onclick=async function(){try{var type=b.dataset.refType,ref;if(type==='current-selection')ref=await selectionReference();else if(type==='current-document')ref={type:'document',documentId:state.document.id,displayName:state.document.name};else if(type==='variable'){var item=(r.variables||[]).find(function(x){return x.variableId===b.dataset.refId});ref={type:'variable',variableId:item.variableId,revisionAtSend:item.revisionAtSend,displayName:item.displayName}}else if(type==='document'){var doc=(r.documents||[]).find(function(x){return x.documentId===b.dataset.refId});ref={type:'document',documentId:doc.documentId,displayName:doc.displayName}}else{var render=(r.renders||[]).find(function(x){return x.id===b.dataset.refId});ref={type:'render-record',renderId:render.id,displayName:render.displayName||render.id}}if(!state.references.some(function(x){return x.type===ref.type&&(x.variableId||x.documentId||x.renderId)===(ref.variableId||ref.documentId||ref.renderId)}))state.references.push(ref);var input=$('#conversationInput'),match=/@([^\s@]*)$/.exec(input.value);if(match&&type!=='current-selection')input.value=input.value.slice(0,match.index)+'@'+(ref.displayName||'引用')+' ';rememberDraft();await loadReferences();RA.toast('已添加引用 '+(ref.displayName||''))}catch(error){RA.toast(error.message,'err')}}});
    $$('[data-remove-ref]').forEach(function(b){b.onclick=function(){state.references.splice(Number(b.dataset.removeRef),1);rememberDraft();loadReferences().catch(function(){})}})
  }
  async function send(){if(!state.project||!state.conversation)throw new Error('请先打开项目会话');var text=$('#conversationInput').value.trim();if(!text)return;var conversationId=state.conversation.id,result=await api('/api/projects/'+state.project.id+'/conversations/'+conversationId+'/messages',{method:'POST',body:{text:text,references:state.references}});$('#conversationInput').value='';state.references=[];delete state.drafts[conversationId];await load();if(result.task&&result.task.id)pollTask(result.task.id).catch(function(e){RA.toast(e.message,'err')})}
  async function pollTask(taskId){for(var i=0;i<240;i++){await new Promise(function(resolve){setTimeout(resolve,1000)});var data=await api('/api/projects/'+state.project.id+'/conversations/'+state.conversation.id);var task=(data.tasks||[]).find(function(x){return x.id===taskId});renderMessages(data.messages||[],data.tasks||[]);if(!task||['completed','failed','cancelled','interrupted','waiting_user'].indexOf(task.status)>=0){loadTimeline().catch(function(){});return}}}
  async function create(){if(!state.project)return;rememberDraft();state.conversation=(await api('/api/projects/'+state.project.id+'/conversations',{method:'POST',body:{title:'新的工作会话'}})).conversation;state.references=[];$('#conversationInput').value='';await load()}
  async function confirmOperation(taskId,operationId){await api('/api/projects/'+state.project.id+'/tasks/'+encodeURIComponent(taskId)+'/operations/'+encodeURIComponent(operationId)+'/confirm',{method:'POST',body:{}});await load();RA.toast('已确认执行，正在验证文档结果')}
  async function newVariable(){if(!state.project)throw new Error('请先将当前文件加入项目');show();await load();var input=$('#conversationInput');try{var ref=await selectionReference();state.references.push(ref);input.value='请从当前选区提取有用的数据，使用 Sandbox 确定性计算，并根据内容命名变量。'}catch(error){state.references.push({type:'document',documentId:state.document.id,displayName:state.document.name});input.value='请检查当前文件并告诉我可以提取哪些数据；确认后再创建变量。'}rememberDraft();await loadReferences();input.focus()}
  async function referenceVariable(variableId){if(!state.project)throw new Error('请先将当前文件加入项目');var result=await api('/api/projects/'+state.project.id+'/references'),item=(result.variables||[]).find(function(x){return x.variableId===variableId});if(!item)throw new Error('变量不存在或已删除');state.references.push({type:'variable',variableId:item.variableId,revisionAtSend:item.revisionAtSend,displayName:item.displayName});show();await load();$('#conversationInput').value='请分析并按我的要求更新这个变量：';rememberDraft();$('#conversationInput').focus();await loadReferences()}
  async function renameConversation(){if(!state.conversation)return;var title=global.prompt('为这个会话命名',state.conversation.title);if(title===null||!title.trim())return;await api('/api/projects/'+state.project.id+'/conversations/'+state.conversation.id,{method:'PATCH',body:{title:title.trim()}});state.conversation.title=title.trim();$('#conversationTitle').textContent=state.conversation.title;await resolve();$('#conversationMenu').classList.add('hidden')}
  async function compactConversation(){if(!state.conversation)return;await api('/api/projects/'+state.project.id+'/conversations/'+state.conversation.id+'/compact',{method:'POST',body:{}});$('#conversationMenu').classList.add('hidden');RA.toast('上下文已压缩；项目事实和历史记录未改变')}
  async function archiveConversation(){if(!state.conversation)return;if(!global.confirm('归档此会话？归档不会删除聊天记录或项目数据。'))return;await api('/api/projects/'+state.project.id+'/conversations/'+state.conversation.id,{method:'PATCH',body:{archived:true}});state.conversation=null;state.references=[];$('#conversationInput').value='';$('#conversationMenu').classList.add('hidden');await load()}
  $('#viewConversation').onclick=function(){show();load().catch(function(e){RA.toast(e.message,'err')})};$('#sendConversation').onclick=function(){send().catch(function(e){RA.toast(e.message,'err')})};$('#newConversation').onclick=function(){create().catch(function(e){RA.toast(e.message,'err')})};$('#insertReference').onclick=function(){loadReferences().catch(function(e){RA.toast(e.message,'err')})};
  $('#conversationSelect').onchange=function(){var id=this.value;rememberDraft();api('/api/projects/'+state.project.id+'/conversations').then(function(result){state.conversation=(result.conversations||[]).find(function(item){return item.id===id})||null;if(!state.conversation)throw new Error('会话已归档或不存在');restoreDraft();return load()}).catch(function(e){RA.toast(e.message,'err')})};
  $('#conversationMore').onclick=function(){var menu=$('#conversationMenu');menu.classList.toggle('hidden')};$('#renameConversation').onclick=function(){renameConversation().catch(function(e){RA.toast(e.message,'err')})};$('#compactConversation').onclick=function(){compactConversation().catch(function(e){RA.toast(e.message,'err')})};$('#archiveConversation').onclick=function(){archiveConversation().catch(function(e){RA.toast(e.message,'err')})};
  var searchTimer;$('#conversationInput').addEventListener('input',function(){rememberDraft();clearTimeout(searchTimer);var match=/@([^\s@]*)$/.exec(this.value);if(match)searchTimer=setTimeout(function(){loadReferences(match[1]).catch(function(){})},180)});
  global.RAConversation={start:function(){return load().then(show)},show:show,newVariable:newVariable,referenceVariable:referenceVariable,refreshTimeline:loadTimeline};
})(window);
