// Optional local browser harness: real Core API with a simulated WPS host.
// Start Core on 17892 with isolated data, then `node tests/browser-fixture-server.cjs`.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../addins');
http.createServer((req,res)=>{
 if(req.url.startsWith('/api/')){const upstream=http.request({hostname:'127.0.0.1',port:17892,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:17892'}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});upstream.on('error',e=>{res.writeHead(502);res.end(e.message)});req.pipe(upstream);return}
 if(req.url==='/test-host.js') {res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(__dirname,'helpers/portable-hosts.cjs'),'utf8')+`
 window.Application=makeSheetHost();
 const saved=sessionStorage.getItem('test-sheet');if(saved){const grid=JSON.parse(saved);Application.grid.forEach((row,y)=>row.forEach((cell,x)=>Object.assign(cell,grid[y][x])))}
 addEventListener('pagehide',()=>sessionStorage.setItem('test-sheet',JSON.stringify(Application.grid)));
 `);return}
 const url=new URL(req.url,'http://127.0.0.1'),file=path.resolve(root,'.'+decodeURIComponent(url.pathname.replace(/^\/addins/,'')));
 if(!file.startsWith(root+path.sep)){res.writeHead(404);res.end();return}
 try{let body=fs.readFileSync(file);res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream');if(file.endsWith('workspace/taskpane.html'))body=body.toString().replace('<script src="../wpp/common.js">','<script src="/test-host.js"></script><script src="../wpp/common.js">');res.end(body)}catch(e){res.writeHead(404);res.end('Not found')}
}).listen(17893,'127.0.0.1',()=>console.log('Test-only browser fixture: http://127.0.0.1:17893/addins/workspace/taskpane.html?host=et'));
