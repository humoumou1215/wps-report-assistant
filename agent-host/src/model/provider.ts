import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { fail } from "../../../shared/contracts/index.js";
export async function modelProvider(
  dir: string,
  settings: any,
): Promise<{ runtime: ModelRuntime; model: any }> {
  if (!settings.enabled || !settings.model)
    fail("MODEL_ERROR", "请先配置并启用模型", 400);
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "pi-isolated", "auth.json"),
    modelsPath: null,
    modelsStorePath: join(dir, "pi-isolated", "models-cache.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider("report-assistant", {
    api: "openai-completions",
    baseUrl: settings.baseUrl,
    authHeader: true,
    models: [
      {
        id: settings.model,
        name: settings.model,
        reasoning: !!settings.thinking && settings.thinking !== "off",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64000,
        maxTokens: 8192,
        compat: settings.compat,
      },
    ],
  });
  await runtime.setRuntimeApiKey(
    "report-assistant",
    settings.apiKey || "local-no-key",
  );
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) =>
    stream(model, context, {
      temperature: settings.temperature ?? 0.1,
      ...options,
    });
  const model = runtime.getModel("report-assistant", settings.model);
  if (!model) fail("MODEL_ERROR", "无法创建模型");
  return { runtime, model: model! };
}
