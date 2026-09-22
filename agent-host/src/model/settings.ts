import { join } from "node:path";
import { atomic, readJSON } from "../project/store.js";
export class Settings {
  private value: any;
  private key = "";
  private queue: Promise<void> = Promise.resolve();
  constructor(private dir: string) {}
  async open() {
    this.value = await readJSON(join(this.dir, "settings.json"), {
      ai: {
        enabled: false,
        baseUrl: "https://api.openai.com/v1",
        model: "",
        temperature: 0.1,
      },
      agent: { criticEnabled: true },
      debug: { enabled: false, includeSourceData: false, maxEvents: 2000 },
    });
    const secret = await readJSON(join(this.dir, "secrets", "ai.json"), {});
    this.key = secret.apiKey || this.value.ai?.apiKey || "";
    this.value.ai ||= {};
    delete this.value.ai.apiKey;
    await atomic(join(this.dir, "secrets", "ai.json"), { apiKey: this.key });
    await atomic(join(this.dir, "settings.json"), this.value);
    return this;
  }
  public() {
    return {
      ...structuredClone(this.value),
      ai: { ...this.value.ai, apiKeyConfigured: !!this.key },
    };
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
    const next = structuredClone(this.value);
    if (body.ai) {
      for (const k of [
        "enabled",
        "baseUrl",
        "model",
        "temperature",
        "thinking",
        "compat",
      ])
        if (body.ai[k] !== undefined) next.ai[k] = body.ai[k];
      if (body.ai.apiKey !== undefined && body.ai.apiKey !== "••••••••") {
        this.key = String(body.ai.apiKey);
        await atomic(join(this.dir, "secrets", "ai.json"), {
          apiKey: this.key,
        });
      }
    }
    for (const k of ["debug", "agent"])
      if (body[k]) next[k] = { ...next[k], ...body[k] };
    next.agent = {
      ...next.agent,
      criticEnabled: true,
      dynamicCapabilitiesEnabled: false,
    };
    await atomic(join(this.dir, "settings.json"), next);
    this.value = next;
  }
  redact(text: string) {
    return this.key ? text.split(this.key).join("[REDACTED]") : text;
  }
}
