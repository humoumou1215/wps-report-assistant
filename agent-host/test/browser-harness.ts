// Development-only host with scripted generation, outside the production entrypoint.
import { mkdtemp, cp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/project/store.js";
import { Settings } from "../src/model/settings.js";
import { AgentService } from "../src/agent/runtime.js";
import { createHost } from "../src/server/http-server.js";
const dir = await mkdtemp(join(tmpdir(), "ra-browser-")),
  assets = join(dir, "addins");
await cp(resolve("../addins"), assets, { recursive: true });
const helper = await readFile(
  resolve("../tests/helpers/portable-hosts.cjs"),
  "utf8",
);
await writeFile(
  join(assets, "test-host.js"),
  helper + "\nwindow.Application=makeSheetHost();",
);
const html = await readFile(join(assets, "workspace", "taskpane.html"), "utf8");
await writeFile(
  join(assets, "workspace", "taskpane.html"),
  html.replace(
    '<script src="../wpp/common.js">',
    '<script src="../test-host.js"></script><script src="../wpp/common.js">',
  ),
);
const store = await new Store(join(dir, "data")).open(),
  settings = await new Settings(join(dir, "data")).open();
const agents = new AgentService(
  store,
  {
    async run(input) {
      input.onTurn();
      const context = JSON.parse(input.context),
        render = context.stage === "render";
      for (const [name, args] of [
        [render ? "inspect_variable" : "inspect_source", {}],
        [
          render ? "run_renderer_candidate" : "run_transform_candidate",
          {
            code: render
              ? 'function render(variable,target){return {kind:"table",header:variable.columns,rows:variable.value.map(r=>variable.columns.map(c=>r[c]))}}'
              : 'function transform(rows,columns){return {valueType:"table",columns,value:rows}}',
          },
        ],
        ["validate_candidate", {}],
      ] as any)
        await input.tools
          .find((t) => t.name === name)!
          .execute("call", args, undefined, undefined, {} as any);
    },
  },
  { review: async () => ({ passed: true, issues: [], repairInstruction: "" }) },
);
createHost(store, settings, agents, assets).listen(17894, "127.0.0.1", () =>
  console.log(
    JSON.stringify({
      url: "http://127.0.0.1:17894/addins/workspace/taskpane.html?host=et",
      dir,
    }),
  ),
);
