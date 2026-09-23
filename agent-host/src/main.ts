import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireHostLock } from "./project/host-lock.js";
import { cleanupResults } from "./project/cleanup.js";
import { Store } from "./project/store.js";
import { Settings } from "./model/settings.js";
import { PiRuntime } from "./agent/pi-runtime.js";
import { StatelessCritic } from "./agent/critic.js";
import { createHost } from "./server/http-server.js";
import { readAppVersion } from "./version.js";
import { CapabilityRegistry } from "./render/capabilities.js";
import { RenderGateway } from "./render/gateway.js";
import { WpsBridge } from "./render/wps-bridge.js";
import { ConversationAgent } from "./agent/conversation-agent.js";
import { ConversationService } from "./project/conversations.js";
let startupStage = "initializing";
async function main() {
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    const version = await readAppVersion();
    startupStage = "resolving data directory";
    const data =
      process.env.REPORT_ASSISTANT_DATA_DIR ||
      (process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "DataReportAssistant", "data")
        : process.platform === "win32"
          ? join(process.env.LOCALAPPDATA || homedir(), "DataReportAssistant", "data")
          : join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "DataReportAssistant", "data"));
    console.error(
      `Agent Host ${version}: node=${process.version}; exec=${process.execPath}; data=${data}`,
    );
  startupStage = "acquiring data directory lock";
  const release = await acquireHostLock(data);
  releaseLock = release;
  startupStage = "opening project store";
  const store = await new Store(data).open();
  startupStage = "opening settings";
  const settings = await new Settings(data).open();
  const wpsBridge = new WpsBridge();
  const renderCapabilities = new CapabilityRegistry();
  for (const capabilityId of ["et.range", "wpp.object", "wps.range"])
    renderCapabilities.register(wpsBridge.capability(capabilityId));
  const renderGateway = new RenderGateway(store, renderCapabilities);
  await cleanupResults(store);
  setInterval(
    () => void cleanupResults(store).catch(() => {}),
    60 * 60 * 1000,
  ).unref();
  startupStage = "creating Conversation Agent";
  const piRuntime = new PiRuntime(data, () => settings.provider());
  const critic = new StatelessCritic(data, () => settings.provider());
  const conversationAgent = new ConversationAgent(store, piRuntime, renderGateway, wpsBridge, critic, undefined, () => settings.public());
  const conversationService = new ConversationService(store, piRuntime);
  const assets =
    process.env.REPORT_ASSISTANT_ASSET_DIR ||
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../../addins");
  startupStage = `starting HTTP server on 127.0.0.1:${Number(process.env.REPORT_ASSISTANT_PORT || 17891)}`;
  const server = createHost(store, settings, assets, { version, conversationService, renderGateway, wpsBridge, conversationAgent });
  server.listen(
    Number(process.env.REPORT_ASSISTANT_PORT || 17891),
    "127.0.0.1",
    () =>
      console.log(
        "Report Assistant Agent Host listening on 127.0.0.1:" +
          (server.address() as any).port,
      ),
  );
  server.on("error", async (err) => {
    console.error(err.message);
    await release();
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      server.close(async () => {
        await release();
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5000).unref();
    });
  } catch (error) {
    await releaseLock?.();
    throw error;
  }
}
void main().catch((error) => {
  console.error(
    "Agent Host 启动失败：请检查数据目录、文件格式、权限及端口。原始文件未被覆盖。",
  );
  console.error(`启动阶段：${startupStage}`);
  if (error instanceof Error) console.error(error.stack || `${error.name}: ${error.message}`);
  else console.error(String(error));
  process.exitCode = 1;
});
