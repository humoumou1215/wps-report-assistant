const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {makeSheetHost}=require('./helpers/portable-hosts.cjs');
const {mockShape}=require('./helpers/wps-host.cjs');
function fixture(app){const c={Application:app,console};c.window=c;for(const file of ['wpp/change-state.js','workspace/hosts.js'])vm.runInNewContext(fs.readFileSync('addins/'+file,'utf8'),c);return c}
test('spreadsheet reads scalars and tables and restores typed values, style and formula metadata',()=>{
 const a=makeSheetHost(),c=fixture(a),h=c.RAHosts.capability('et.range'),s=c.RAChangeState;
 assert.equal(h.read({sheetName:'Sheet1',address:'A1:B3'}).values[1][0],'研发');
 assert.equal(h.read({sheetName:'Sheet1',address:'B2'}).values[1][0],10);
 a.Selection=a.range('B2');const target=h.selection('text'),w=c.RAHosts.resolve(target),before=s.capture(w);
 s.apply(w,{kind:'text',text:'=1+1'});assert.equal(a.grid[1][1].Value2,'=1+1');assert.equal(a.grid[1][1].HasFormula,false);
 s.restore(w,before);assert.equal(a.grid[1][1].Value2,10);assert.ok(s.equal(s.capture(w),before));
 a.grid[1][1].Font.Bold=true;assert.equal(s.equal(s.capture(w),before),false);
});
test('spreadsheet overflow and merged cells are rejected before writes',()=>{
 const a=makeSheetHost(),c=fixture(a),h=c.RAHosts.capability('et.range');
 assert.throws(()=>h.apply(a.range('A1'),{kind:'table',rows:[['a'],['b']]}),/目标区域/);assert.equal(a.grid[0][0].Value2,'部门');
 a.grid[1][1].MergeCells=true;assert.throws(()=>h.snapshot(a.range('A1:B3')),/合并/);
});
test('presentation becomes an input and preserves legacy undo behavior',()=>{
 const shape=mockShape('输入文本');shape.Name='Title';
 const slide={SlideID:3,SlideIndex:1,Shapes:{Count:1,Item:()=>shape}},a={ActivePresentation:{Name:'deck.odp',Path:'/validation',FullName:'/validation/deck.odp',Slides:{Count:1,Item:()=>slide}},ActiveWindow:{View:{Slide:slide},Selection:{ShapeRange:{Item:()=>shape}}}},c=fixture(a),h=c.RAHosts.capability('wpp.object'),target=h.selection(),w=c.RAHosts.resolve(target),s=c.RAChangeState;
 assert.equal(h.read(target.locator).values[1][0],'输入文本');const before=s.capture(w);s.apply(w,{kind:'text',text:'输出'});s.restore(w,before);assert.equal(shape.TextFrame.TextRange.Text,'输入文本');
 assert.equal(c.RAHosts.resolve({slideId:3,shapeId:5}).object,shape);
});
test('new host capability works without file suffix or built-in host gates',()=>{
 const c=fixture({}),h=c.RAHosts,s=c.RAChangeState,object={text:'original'};
 h.registerHost({id:'canvas',app:()=>object,document:()=>({key:'/validation/file.custom',kind:'canvas'})});
 h.registerCapability({id:'canvas.text',host:'canvas',inputTypes:['text'],outputTypes:['text'],selection:()=>({capabilityId:'canvas.text',locator:{id:1}}),read:()=>({values:[['内容'],[object.text]]}),locate:()=>object,snapshot:o=>({version:1,kind:'text',text:{text:o.text}}),preflight(){},apply:(o,p)=>{o.text=p.text},restore:(o,b)=>{o.text=b.text.text}});
 const w=h.resolve(h.capability('canvas.text').selection()),before=s.capture(w);s.apply(w,{kind:'text',text:'updated'});s.restore(w,before);assert.equal(object.text,'original');assert.equal(h.forHost('canvas').length,1);
});
function writerHost(){
 let text='原始文本',format='bold',bookmark=null;
 const doc={Name:'writer.odt',FullName:'/validation/writer.odt',Path:'/validation',TrackRevisions:false,ReadOnly:false};
 doc.Range=(start,end)=>({Start:start,End:end,Tables:{Count:0},get Text(){return text.slice(start,end)},set Text(v){text=text.slice(0,start)+v+text.slice(end);end=start+v.length;this.End=end;format='plain'},get WordOpenXML(){return JSON.stringify({text:text.slice(start,end),format})},InsertXML(xml){const old=JSON.parse(xml);text=text.slice(0,start)+old.text+text.slice(end);format=old.format;end=start+old.text.length;this.End=end}});
 doc.Bookmarks={Exists:()=>!!bookmark,Item:()=>({get Range(){return doc.Range(bookmark.start,bookmark.end)},Delete(){bookmark=null}}),Add:(name,r)=>{bookmark={name,start:r.Start,end:r.End}}};
 return {ActiveDocument:doc,Selection:{Range:doc.Range(0,text.length)},getText:()=>text,removeBookmark:()=>{bookmark=null}};
}
test('Writer reads text and roundtrips XML formatting through a fresh range',()=>{
 const a=writerHost(),c=fixture(a),h=c.RAHosts.capability('wps.range'),s=c.RAChangeState,target=h.selection(),w=c.RAHosts.resolve(target),before=s.capture(w);
 assert.equal(h.read(target.locator).values[1][0],'原始文本');s.apply(w,{kind:'text',text:'较长的渲染结果'});assert.equal(s.content(s.capture(w)),'较长的渲染结果');
 s.restore(w,before);assert.equal(a.getText(),'原始文本');assert.ok(s.equal(s.capture(w),before));
});
test('Writer refuses missing format APIs, tracked changes and deleted positioning bookmark',()=>{
 const a=writerHost(),c=fixture(a),h=c.RAHosts.capability('wps.range'),target=h.selection(),w=c.RAHosts.resolve(target),s=c.RAChangeState;
 a.ActiveDocument.TrackRevisions=true;assert.throws(()=>s.capture(w),/修订/);a.ActiveDocument.TrackRevisions=false;
 assert.throws(()=>h.snapshot({WordOpenXML:''},target.locator),/格式快照/);
 s.capture(w);s.apply(w,{kind:'text',text:'已经修改后的内容'});s.capture(w);a.removeBookmark();assert.throws(()=>s.capture(w),/书签/);assert.equal(a.getText(),'已经修改后的内容');
});
