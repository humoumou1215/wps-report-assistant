const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {mockShape} = require('./helpers/wps-host.cjs');
require('../addins/wpp/change-state.js');
const state = global.RAChangeState;
const copy = x => JSON.parse(JSON.stringify(x));
function fixture(options={}) {
 const elements={},records=[],shapes=[mockShape('before'),mockShape('second')];let id=0,confirmed=0,documentKey='doc';
 const element=id=>elements[id]||(elements[id]={classList:{toggle(){}},textContent:'',innerHTML:'',disabled:false});
 const context={console,document:{querySelector:element},confirm(){confirmed++;return true},RAChangeState:state};context.window=context;
 context.RA={$:element,$$:()=>[],esc:x=>String(x??'').replace(/</g,'&lt;'),makeTraceId:()=>String(++id),toast(){},api:async(url,opt)=>{
  if(!opt){return {changes:copy(records.slice().reverse())};}
  if(!url.includes('/entries/')){
   if(options.prepareFails)throw new Error('offline');
   const existing=records.find(r=>r.id===opt.body.requestId);if(existing)return {change:copy(existing)};
   const c={id:opt.body.requestId,label:opt.body.label,createdAt:new Date().toISOString(),entries:opt.body.entries.map((e,i)=>({before:copy(e.before),plan:e.expectedPlan,target:{shapeId:i,slideIndex:1,shapeName:'对象'+i},afterBinding:{id:'b'+i,description:'金额'},status:'prepared'}))};records.push(c);
   if(options.switchDocument)documentKey='other';
   return {change:copy(c)};
  }
  const n=Number(url.split('/').at(-1)),record=records.at(-1),e=record.entries[n],action=opt.body.action;
  if(action==='complete') {e.after=copy(opt.body.snapshot);e.status='applied';if(options.loseComplete){options.loseComplete--;throw new Error('lost response');}}
  if(action==='fail')e.status='failed';
  if(action==='undo-start'||action==='recover-start')e.status='undoing';
  if(action==='undo-complete')e.status='undone';
  return {change:copy(record)};
 }};
 vm.runInNewContext(fs.readFileSync(require.resolve('../addins/wpp/change-history.js'),'utf8'),context);
 const hooks={context:()=>({projectId:'p',documentId:'d',documentKey}),findShape:t=>shapes[t.shapeId],refresh:async()=>{},adjust(){},showHistory(){}};
 const manager=context.createChangeHistory(hooks);
 const requests=()=>shapes.map((s,i)=>({bindingId:'b'+i,target:{shapeId:i},plan:{kind:'text',text:'new'+i}}));
 return {manager,records,shapes,requests,element,context,hooks,confirmed:()=>confirmed};
}
test('durable prepare failure never mutates original',async()=>{
 const f=fixture({prepareFails:true});await assert.rejects(f.manager.run([f.requests()[0]],'修改'),/offline/);assert.equal(f.shapes[0].writes(),0);
});
test('lost commit response retries metadata, never repeats host write',async()=>{
 const f=fixture({loseComplete:1});await f.manager.run([f.requests()[0]],'修改');assert.equal(f.records.length,1);assert.equal(f.shapes[0].writes(),1);assert.equal(f.records[0].entries[0].status,'applied');
});
test('undo persists across controller recreation and rejects later manual editing',async()=>{
 const f=fixture();await f.manager.run([f.requests()[0]],'修改');const after=state.capture(f.shapes[0]);f.shapes[0].TextFrame.TextRange.Text='manual';await f.manager.undo();assert.equal(f.shapes[0].TextFrame.TextRange.Text,'manual');assert.match(f.element('#changeFeedback').textContent,/后续修改/);
 state.restore(f.shapes[0],after);const reopened=f.context.createChangeHistory(f.hooks);await reopened.undo();assert.equal(f.shapes[0].TextFrame.TextRange.Text,'before');assert.equal(f.records[0].entries[0].status,'undone');
});
test('batch records partial failure and restores successful changes in reverse',async()=>{
 const f=fixture();f.shapes[1].failNext();await f.manager.run(f.requests(),'批量');assert.deepEqual(f.records[0].entries.map(e=>e.status),['applied','failed']);await f.manager.undo();assert.equal(f.shapes[0].TextFrame.TextRange.Text,'before');assert.equal(f.shapes[1].TextFrame.TextRange.Text,'second');
});
test('document switch after prepare does not write another document',async()=>{
 const f=fixture({switchDocument:true});await assert.rejects(f.manager.run([f.requests()[0]],'修改'),/文稿已切换/);assert.equal(f.shapes[0].writes(),0);assert.equal(f.records[0].entries[0].status,'prepared');
});
test('interrupted operation is explicit and recoverable',async()=>{
 const f=fixture({loseComplete:3});await assert.rejects(f.manager.run([f.requests()[0]],'修改'),/lost response/);
 // Simulate a crash before Core received the final host state.
 f.records[0].entries[0].status='prepared';delete f.records[0].entries[0].after;
 await f.manager.undo();assert.equal(f.confirmed(),1);assert.equal(f.shapes[0].TextFrame.TextRange.Text,'before');assert.equal(f.records[0].entries[0].status,'undone');
});
