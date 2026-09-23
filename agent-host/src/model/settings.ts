import { join } from "node:path";
import { fail } from "../../../shared/contracts/index.js";
import { atomic, readJSON } from "../project/store.js";

const defaults = () => ({
  ai: { enabled: false, baseUrl: "https://api.openai.com/v1", model: "", temperature: 0.1 },
  automation: { renderExecutionMode: "auto-reversible", autoRefreshVariables: true },
  ui: { timelineScope: "current-document", liveVariableStatus: true },
});

export class Settings {
  private value = defaults();
  private key = "";
  private queue: Promise<void> = Promise.resolve();

  constructor(private dir: string) {}

  async open() {
    const saved = await readJSON(join(this.dir, "settings.json"), {});
    const secret = await readJSON(join(this.dir, "secrets", "ai.json"), {});
    this.key = typeof secret.apiKey === "string" ? secret.apiKey : "";
    this.value = {
      ai: { ...defaults().ai, ...pick(saved.ai, ["enabled", "baseUrl", "model", "temperature", "thinking", "compat"]) },
      automation: { ...defaults().automation, ...pick(saved.automation, ["renderExecutionMode", "autoRefreshVariables"]) },
      ui: { ...defaults().ui, ...pick(saved.ui, ["timelineScope", "liveVariableStatus"]) },
    };
    delete (this.value.ai as any).apiKey;
    await atomic(join(this.dir, "settings.json"), this.value);
    return this;
  }

  public() {
    return { ...structuredClone(this.value), ai: { ...this.value.ai, apiKeyConfigured: !!this.key } };
  }

  provider() {
    return { ...structuredClone(this.value.ai), apiKey: this.key };
  }

  update(body: any) {
    const task = this.queue.then(() => this.writeUpdate(body));
    this.queue = task.catch(() => {});
    return task;
  }

  private async writeUpdate(body: any) {
    const renderMode = body?.automation?.renderExecutionMode;
    if (renderMode !== undefined && !["review", "auto-reversible", "auto"].includes(renderMode))
      fail("INVALID_SETTINGS", "文档修改权限模式无效", 400);
    const timelineScope = body?.ui?.timelineScope;
    if (timelineScope !== undefined && !["current-document", "project"].includes(timelineScope))
      fail("INVALID_SETTINGS", "修改时间线范围无效", 400);
    for (const [group, fields] of Object.entries({ automation: ["autoRefreshVariables"], ui: ["liveVariableStatus"] })) {
      const values = body?.[group];
      if (values) for (const field of fields)
        if (values[field] !== undefined && typeof values[field] !== "boolean")
          fail("INVALID_SETTINGS", `${field} 必须是布尔值`, 400);
    }

    const next = structuredClone(this.value);
    if (body?.ai) {
      Object.assign(next.ai, pick(body.ai, ["enabled", "baseUrl", "model", "temperature", "thinking", "compat"]));
      if (body.ai.apiKey !== undefined && body.ai.apiKey !== "••••••••") {
        this.key = String(body.ai.apiKey);
        await atomic(join(this.dir, "secrets", "ai.json"), { apiKey: this.key });
      }
    }
    if (body?.automation) Object.assign(next.automation, pick(body.automation, ["renderExecutionMode", "autoRefreshVariables"]));
    if (body?.ui) Object.assign(next.ui, pick(body.ui, ["timelineScope", "liveVariableStatus"]));
    await atomic(join(this.dir, "settings.json"), next);
    this.value = next;
  }

  redact(text: string) {
    return this.key ? text.split(this.key).join("[REDACTED]") : text;
  }
}

function pick(source: any, keys: string[]) {
  if (!source || typeof source !== "object") return {};
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}
