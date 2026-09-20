const test = require('node:test');
const assert = require('node:assert/strict');
require('../addins/wpp/change-state.js');
const S = global.RAChangeState;
const copy = x => JSON.parse(JSON.stringify(x));
const {mockShape,mockTable} = require('./helpers/wps-host.cjs');
test('rich text content and mixed fonts restore exactly',()=>{
 const shape=mockShape();const before=S.capture(shape);S.apply(shape,{kind:'text',text:'123万元'});assert.notEqual(S.content(S.capture(shape)),S.content(before));S.restore(shape,before);assert.ok(S.equal(S.capture(shape),before));
});
test('fixed-size table content restores exactly',()=>{
 const shape=mockTable(),before=S.capture(shape);S.apply(shape,{kind:'table',rows:[['1280']],resizeRows:true});assert.equal(shape.cell.TextFrame.TextRange.Text,'1280');S.restore(shape,before);assert.ok(S.equal(S.capture(shape),before));
});
test('row resize and merged cells fail before any mutation',()=>{
 const shape=mockTable();assert.throws(()=>S.apply(shape,{kind:'table',rows:[['a'],['b']],resizeRows:true}),/行数/);assert.equal(shape.cell.writes(),0);shape.cell.Width=200;assert.throws(()=>S.capture(shape),/合并/);assert.equal(shape.cell.writes(),0);
});
test('missing formatting capability blocks capture; no silent text-only undo',()=>{
 const shape=mockShape();delete shape.TextFrame.AutoSize;assert.throws(()=>S.capture(shape),/AutoSize/);assert.equal(shape.writes(),0);
});
test('manual text or font edits change conflict fingerprint',()=>{
 const shape=mockShape(),before=S.capture(shape);shape.TextFrame.TextRange.Characters(1,1).Font.Size=42;assert.equal(S.equal(S.capture(shape),before),false);
});
