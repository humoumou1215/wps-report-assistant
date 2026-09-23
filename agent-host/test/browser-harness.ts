// Development-only host with scripted generation, outside the production entrypoint.
import { mkdtemp, cp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/project/store.js";
import { Settings } from "../src/model/settings.js";
import { ConversationAgent } from "../src/agent/conversation-agent.js";
import { CapabilityRegistry } from "../src/render/capabilities.js";
import { RenderGateway } from "../src/render/gateway.js";
import { WpsBridge } from "../src/render/wps-bridge.js";
import { ConversationService } from "../src/project/conversations.js";
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
const bridge = new WpsBridge();
const capabilities = new CapabilityRegistry();
for (const capabilityId of ["et.range", "wpp.object", "wps.range"])
  capabilities.register(bridge.capability(capabilityId));
const gateway = new RenderGateway(store, capabilities);
const conversationRuntime = {
  async run() {
    return {
      assistantText: "仿真助手已收到任务。",
      sessionEntryId: null,
      tokenUsage: {},
    };
  },
  async compact() {
    return true;
  },
};
const conversationAgent = new ConversationAgent(
  store,
  conversationRuntime as any,
  gateway,
  bridge,
  { review: async () => ({ passed: true, issues: [], repairInstruction: "" }) },
  undefined,
  () => settings.public(),
);
createHost(store, settings, assets, { version: "test", conversationService: new ConversationService(store, conversationRuntime), renderGateway: gateway, wpsBridge: bridge, conversationAgent }).listen(17894, "127.0.0.1", () =>
  console.log(
    JSON.stringify({
      url: "http://127.0.0.1:17894/addins/workspace/taskpane.html?host=et",
      dir,
    }),
  ),
);
