import { parse } from "acorn";
import { fail } from "../../../shared/contracts/index.js";
export function normalizeScript(
  input: string,
  stage: "transform" | "render",
): string {
  const code = input
    .trim()
    .replace(/^```(?:javascript|js)?\s*\n([\s\S]*?)\n```$/, "$1");
  if (!code || Buffer.byteLength(code) > 65536)
    return fail("SCRIPT_CONTRACT_ERROR", "代码为空或超过 64KB");
  const args = stage === "transform" ? "rows, columns, sources" : "variable, target";
  let ast: any;
  try {
    ast = parse(code, { ecmaVersion: "latest" });
  } catch {
    try {
      parse(`function ${stage}(${args}) {\n${code}\n}`, {
        ecmaVersion: "latest",
      });
      return `function ${stage}(${args}) {\n${code}\n}`;
    } catch {
      return fail(
        "SCRIPT_SYNTAX",
        "JavaScript 语法错误",
        422,
        `请返回完整 function ${stage}(${args}) {...}`,
      );
    }
  }
  const nodes = ast.body.filter((n: any) => n.type !== "EmptyStatement");
  if (nodes.length === 1) {
    const n = nodes[0];
    if (
      n.type === "FunctionDeclaration" &&
      n.id?.name === stage &&
      !n.async &&
      !n.generator
    )
      return code;
    const fn =
      n.type === "ExpressionStatement"
        ? n.expression
        : n.type === "VariableDeclaration" && n.declarations.length === 1
          ? n.declarations[0].init
          : null;
    if (
      fn &&
      ["ArrowFunctionExpression", "FunctionExpression"].includes(fn.type) &&
      !fn.async &&
      !fn.generator
    )
      return `const ${stage} = ${code.slice(fn.start, fn.end)};`;
  }
  if (
    nodes.some(
      (n: any) =>
        n.type === "FunctionDeclaration" ||
        n.type === "ImportDeclaration" ||
        n.type === "ExportNamedDeclaration",
    )
  )
    return fail(
      "SCRIPT_CONTRACT_ERROR",
      `请只定义 ${stage} 函数`,
      422,
      "完整函数不能作为函数体再次包裹",
    );
  return `function ${stage}(${args}) {\n${code}\n}`;
}
