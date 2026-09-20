const copy = x => JSON.parse(JSON.stringify(x));
function mockShape(text = '原始文本') {
  let value = text;
  const basic = {Name:'微软雅黑',Size:12,Bold:0,Italic:0,Underline:0,Color:{Type:1,RGB:0}};
  let fonts = Array.from(text, (_, i) => ({...copy(basic),Bold:i % 2 ? -1 : 0}));
  let para = {Alignment:1,Bullet:{Type:0,Visible:0}};
  let countWrites = 0, failure = false;
  function range(start, len) {
    const obj = {Start:start+1,Length:len,LanguageID:2052,IndentLevel:1,ParagraphFormat:para};
    Object.defineProperty(obj,'Font',{get(){
      const f = fonts[start] || basic;
      return new Proxy(f,{set(target,key,v){for(let i=start;i<Math.min(fonts.length,start+len);i++)fonts[i][key]=copy(v);target[key]=v;return true;}});
    }});
    return obj;
  }
  const tr = range(0,text.length);
  Object.defineProperty(tr,'Text',{get(){return value;},set(v){countWrites++;if(failure){failure=false;throw new Error('simulated host failure');}value=v;fonts=Array.from(v,()=>copy(basic));}});
  tr.Runs = (i,n) => i === undefined ? {Count:fonts.length} : range(i-1,1);
  tr.Characters = (i,n) => range(i-1,n);
  tr.Paragraphs = i => i === undefined ? {Count:1} : range(0,value.length);
  const shape={Id:5,HasTable:0,Left:1,Top:2,Width:100,Height:40,Rotation:0,LockAspectRatio:0,TextFrame:{AutoSize:0,WordWrap:-1,TextRange:tr}};
  shape.writes=()=>countWrites;shape.failNext=()=>{failure=true};
  return shape;
}
function mockTable() {
  const cell = mockShape('金额');cell.Width=100;cell.Height=40;
  return {Id:6,HasTable:-1,Left:1,Top:2,Width:100,Height:40,Rotation:0,LockAspectRatio:0,Table:{Rows:{Count:1,Item(){return {Height:40}}},Columns:{Count:1,Item(){return {Width:100}}},Cell(){return {Shape:cell}}},cell};
}
module.exports={mockShape,mockTable};
