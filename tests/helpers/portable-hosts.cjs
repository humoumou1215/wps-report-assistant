// Browser-compatible deterministic WPS doubles. Never used by production assets.
(function(root){
 function sheetHost(){
  const grid=Array.from({length:8},()=>Array.from({length:4},()=>({Value2:null,Formula:'',HasFormula:false,NumberFormat:'General',Font:{Name:'Arial',Size:11,Bold:false,Italic:false,Underline:0,Color:0},HorizontalAlignment:1,VerticalAlignment:1,WrapText:false,MergeCells:false})));
  [['部门','金额'],['研发',10],['销售',20]].forEach((r,y)=>r.forEach((v,x)=>grid[y][x].Value2=v));
  function range(address){const m=address.replace(/\$/g,'').match(/^([A-Z])(\d+)(?::([A-Z])(\d+))?$/);if(!m)throw Error('bad address');const x=m[1].charCodeAt(0)-65,y=+m[2]-1,w=(m[3]||m[1]).charCodeAt(0)-65-x+1,h=+(m[4]||m[2])-y;
   return {Address:address,Rows:{Count:h},Columns:{Count:w},get MergeCells(){return grid.slice(y,y+h).some(row=>row.slice(x,x+w).some(c=>c.MergeCells))},get Value2(){return h===1&&w===1?grid[y][x].Value2:grid.slice(y,y+h).map(row=>row.slice(x,x+w).map(c=>c.Value2))},Cells:{Item:(r,c)=>grid[y+r-1][x+c-1]}};
  }
  const sheet={Name:'Sheet1',Range:range},book={Name:'验证数据.xlsx',FullName:'/validation/验证数据.xlsx',Path:'/validation',Worksheets:{Item:()=>sheet}};
  return {ActiveWorkbook:book,ActiveSheet:sheet,Selection:range('A1:B3'),grid,range};
 }
 root.makeSheetHost=sheetHost;
 if(typeof module!=='undefined')module.exports={makeSheetHost:sheetHost};
})(typeof window!=='undefined'?window:globalThis);
