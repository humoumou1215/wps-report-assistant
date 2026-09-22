// Browser-compatible deterministic WPS doubles. Never used by production assets.
(function(root){
 function sheetHost(){
  const grid=Array.from({length:8},()=>Array.from({length:4},()=>({Value2:null,Formula:'',HasFormula:false,NumberFormat:'General',Font:{Name:'Arial',Size:11,Bold:false,Italic:false,Underline:0,Color:0},HorizontalAlignment:1,VerticalAlignment:1,WrapText:false,MergeCells:false})));
  [['部门','金额'],['研发',10],['销售',20]].forEach((r,y)=>r.forEach((v,x)=>grid[y][x].Value2=v));
  const mergedAreas=[];
  function areaFor(y,x){return mergedAreas.find(a=>y>=a.row&&y<a.row+a.rowSpan&&x>=a.column&&x<a.column+a.colSpan)||null}
  function markArea(a,value){for(let yy=a.row;yy<a.row+a.rowSpan;yy++)for(let xx=a.column;xx<a.column+a.colSpan;xx++)grid[yy-1][xx-1].MergeCells=value}
  function cell(y,x){const raw=grid[y-1][x-1];if(!Object.prototype.hasOwnProperty.call(raw,'MergeArea'))Object.defineProperty(raw,'MergeArea',{get(){const a=areaFor(y,x);return a?rangeByCoords(a.row,a.column,a.rowSpan,a.colSpan):rangeByCoords(y,x,1,1)}});raw.Row=y;raw.Column=x;raw.Resize=(h,w)=>rangeByCoords(y,x,h,w);return raw}
  function rangeByCoords(y,x,h,w){const start=y+','+x;return {Address:'$'+String.fromCharCode(64+x)+'$'+y+':$'+String.fromCharCode(64+x+w-1)+'$'+(y+h-1),Row:y,Column:x,Rows:{Count:h},Columns:{Count:w},get MergeCells(){return mergedAreas.some(a=>a.row<y+h&&a.row+a.rowSpan>y&&a.column<x+w&&a.column+a.colSpan>x)||grid.slice(y-1,y-1+h).some(row=>row.slice(x-1,x-1+w).some(c=>c.MergeCells))},get Value2(){return h===1&&w===1?grid[y-1][x-1].Value2:grid.slice(y-1,y-1+h).map(row=>row.slice(x-1,x-1+w).map(c=>c.Value2))},Cells:{Item:(r,c)=>cell(y+r-1,x+c-1)},Resize:(rh,rw)=>rangeByCoords(y,x,rh,rw),Merge(){const a={row:y,column:x,rowSpan:h,colSpan:w};mergedAreas.push(a);markArea(a,true)},UnMerge(){for(let i=mergedAreas.length-1;i>=0;i--){const a=mergedAreas[i];if(a.row<y+h&&a.row+a.rowSpan>y&&a.column<x+w&&a.column+a.colSpan>x){markArea(a,false);mergedAreas.splice(i,1)}}}}}
  function range(address){const m=address.replace(/\$/g,'').match(/^([A-Z])(\d+)(?::([A-Z])(\d+))?$/);if(!m)throw Error('bad address');const x=m[1].charCodeAt(0)-64,y=+m[2],w=(m[3]||m[1]).charCodeAt(0)-64-x+1,h=+(m[4]||m[2])-y+1;return rangeByCoords(y,x,h,w)}
  const sheet={Name:'Sheet1',Range:range},book={Name:'验证数据.xlsx',FullName:'/validation/验证数据.xlsx',Path:'/validation',Worksheets:{Item:()=>sheet}};
  const originalRange=sheet.Range;sheet.Range=originalRange;
  return {ActiveWorkbook:book,ActiveSheet:sheet,Selection:range('A1:B3'),grid,range};
 }
 root.makeSheetHost=sheetHost;
 if(typeof module!=='undefined')module.exports={makeSheetHost:sheetHost};
})(typeof window!=='undefined'?window:globalThis);
