// Deterministic local AI double, used only for browser integration testing.
const http=require('node:http');
http.createServer((req,res)=>{let body='';req.on('data',x=>body+=x);req.on('end',()=>{const request=JSON.parse(body),system=request.messages[0].content,user=JSON.parse(request.messages[1].content);let reply;
if(system.includes('你为 WPS')) reply={code:user.stage==='transform'?'return rows.reduce((sum,row)=>sum+Number(row["金额"]),0);':'return {kind:"text",text:variable.value.toFixed(2)};'};
else reply={passed:false,issues:['模拟复核建议：请人工检查金额单位。']};
res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(reply)}}]}));});}).listen(17894,'127.0.0.1',()=>console.log('Test AI fixture 17894'));
