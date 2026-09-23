import { getQuickJS } from "quickjs-emscripten";
const chunks: Buffer[] = [];
let bytes = 0;
process.stdin.on("data", (b: Buffer) => {
  bytes += b.length;
  if (bytes > 5 * 1024 * 1024 + 70000) process.exit(1);
  chunks.push(b);
});
process.stdin.on("end", async () => {
  let runtime: any, vm: any;
  try {
    const {
      code,
      stage,
      input,
      timeoutMs = 1500,
    } = JSON.parse(Buffer.concat(chunks).toString());
    const Q = await getQuickJS();
    runtime = Q.newRuntime();
    runtime.setMemoryLimit(64 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    const deadline = Date.now() + Math.min(timeoutMs, 1500);
    runtime.setInterruptHandler(() => Date.now() > deadline);
    vm = runtime.newContext();
    const args =
      stage === "transform"
        ? "input.rows,input.columns,input.sources || {}"
        : "input.variable,input.target";
    const program = `'use strict';globalThis.Date=undefined;Math.random=undefined;globalThis.Promise=undefined;
 const input=JSON.parse(${JSON.stringify(JSON.stringify(input))});
 const guardRows=rows=>rows.map(row=>new Proxy(row,{get(obj,key){if(typeof key==='string' && key!=='toJSON' && !Reflect.has(obj,key))throw new Error('SOURCE_SCHEMA_CHANGED: '+key);return Reflect.get(obj,key)}}));
 if(input.rows) input.rows=guardRows(input.rows);
 if(input.sources) for(const key of Object.keys(input.sources)) if(input.sources[key]&&Array.isArray(input.sources[key].rows)) input.sources[key].rows=guardRows(input.sources[key].rows);
 ${code}\nconst result=${stage}(${args});
 if(result===undefined)throw new Error('SCRIPT_NO_RETURN');
 JSON.stringify(result,function(k,v){if(v===undefined||typeof v==='function'||typeof v==='symbol'||typeof v==='bigint'||(typeof v==='number'&&!Number.isFinite(v)))throw new Error('RESULT_SCHEMA_INVALID');return v});`;
    const output = vm.evalCode(program, "candidate.js");
    if (output.error) {
      const err = vm.dump(output.error);
      output.error.dispose();
      const m = String(err.message || err);
      throw new Error(m);
    }
    const json = vm.getString(output.value);
    output.value.dispose();
    if (Buffer.byteLength(json) > 2 * 1024 * 1024)
      throw new Error("SCRIPT_RESULT_TOO_LARGE");
    process.stdout.write(JSON.stringify({ result: JSON.parse(json) }));
  } catch (e) {
    const message = String((e as Error).message);
    const code = message.includes("interrupted")
      ? "SCRIPT_TIMEOUT"
      : [
          "SCRIPT_NO_RETURN",
          "SCRIPT_RESULT_TOO_LARGE",
          "RESULT_SCHEMA_INVALID",
          "SOURCE_SCHEMA_CHANGED",
        ].find((c) => message.includes(c)) || "SCRIPT_CONTRACT_ERROR";
    process.stdout.write(
      JSON.stringify({
        error: {
          code,
          message,
          hint: "请检查函数返回值和当前字段定义后修复代码",
        },
      }),
    );
  } finally {
    vm?.dispose();
    runtime?.dispose();
  }
});
