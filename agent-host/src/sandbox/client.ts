import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AppError, fail } from "../../../shared/contracts/index.js";
import { normalizeScript } from "./normalize-script.js";
import { validateResult } from "./contracts.js";
export async function execute(
  code: string,
  stage: "transform" | "render",
  input: any,
  signal?: AbortSignal,
) {
  const normalized = normalizeScript(code, stage);
  const payload = JSON.stringify({ code: normalized, stage, input });
  if (Buffer.byteLength(JSON.stringify(input)) > 5 * 1024 * 1024)
    fail("SCRIPT_INPUT_TOO_LARGE", "输入超过 5MB");
  const result = await new Promise<any>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./worker.js", import.meta.url))],
      { stdio: ["pipe", "pipe", "ignore"], env: {}, windowsHide: true },
    );
    const output: Buffer[] = [];
    let size = 0,
      done = false;
    const finish = (error?: Error, result?: any) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      child.kill("SIGKILL");
      error ? reject(error) : resolve(result);
    };
    const cancel = () => finish(new AppError("CANCELLED", "任务已取消", 409));
    const timer = setTimeout(
      () => finish(new AppError("SCRIPT_TIMEOUT", "脚本超过执行时限")),
      5000,
    );
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    child.on("error", (e) => finish(e));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024 + 65536)
        finish(new AppError("SCRIPT_RESULT_TOO_LARGE", "脚本输出超过 2MB"));
      else output.push(chunk);
    });
    child.on("close", () => {
      if (done) return;
      try {
        const reply = JSON.parse(Buffer.concat(output).toString("utf8"));
        if (reply.error)
          finish(
            new AppError(
              reply.error.code,
              reply.error.message,
              422,
              reply.error.hint,
            ),
          );
        else finish(undefined, reply.result);
      } catch {
        finish(new AppError("TOOL_INTERNAL_ERROR", "沙箱进程异常退出"));
      }
    });
    if (!done) child.stdin.end(payload);
  });
  return {
    code: normalized,
    result: validateResult(result, stage, input.target),
  };
}
export function sourceRows(values: any[][]) {
  if (!Array.isArray(values) || !Array.isArray(values[0]))
    fail("RESULT_SCHEMA_INVALID", "源数据必须为二维表格");
  const columns = values[0].map(String);
  if (new Set(columns).size !== columns.length || columns.some((c) => !c))
    fail("RESULT_SCHEMA_INVALID", "源字段名称为空或重复");
  return {
    columns,
    rows: values
      .slice(1)
      .map((row) =>
        Object.fromEntries(columns.map((c, i) => [c, row[i] ?? null])),
      ),
  };
}
