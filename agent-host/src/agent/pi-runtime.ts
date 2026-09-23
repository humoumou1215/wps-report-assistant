import {
  createAgentSession,
  compact,
  createExtensionRuntime,
  SettingsManager,
  type ToolDefinition,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { modelProvider } from "../model/provider.js";
import { SessionRegistry } from "./session-registry.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";
export interface AgentRuntime {
  run(input: {
    sessionId: string;
    context: string;
    tools: ToolDefinition[];
    signal: AbortSignal;
    onTurn: () => void;
  }): Promise<void | {
    sessionEntryId: string | null;
    tokenUsage: any;
    model?: string;
    assistantText?: string;
  }>;
  compact?(sessionId: string, instructions?: string): Promise<boolean>;
}
export const COMPACTION_INSTRUCTIONS =
  "保留原始用户目标、用户纠正、已确认业务规则、未解决问题、Task 结论、关键 Tool Error、Variable/Binding ID、Render Record ID 和关键 Tool 调用原因。Session 历史和压缩摘要不是实时业务事实；下一轮必须通过 Tool 读取最新 Project Store。";
export function isolatedLoader(
  compactHandler?: (event: any) => Promise<any>,
): ResourceLoader {
  return {
    getExtensions: () => ({
      extensions: compactHandler
        ? [
            {
              path: "<report-assistant-compaction>",
              resolvedPath: "<report-assistant-compaction>",
              hidden: true,
              sourceInfo: {
                path: "<report-assistant-compaction>",
                source: "report-assistant",
                scope: "temporary" as const,
                origin: "top-level" as const,
              },
              handlers: new Map([["session_before_compact", [compactHandler]]]),
              tools: new Map(),
              messageRenderers: new Map(),
              commands: new Map(),
              flags: new Map(),
              shortcuts: new Map(),
            },
          ]
        : [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => SYSTEM_PROMPT,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
export class PiRuntime implements AgentRuntime {
  constructor(
    private dir: string,
    private settings: () => any,
  ) {}
  private async createSession(sessionId: string, tools: ToolDefinition[] = []) {
    const cfg = this.settings(),
      { runtime, model } = await modelProvider(this.dir, cfg),
      manager = await new SessionRegistry(this.dir).resume(sessionId),
      { session } = await createAgentSession({
        cwd: this.dir,
        agentDir: this.dir + "/pi-isolated",
        modelRuntime: runtime,
        model,
        thinkingLevel: cfg.thinking || "off",
        sessionManager: manager,
        settingsManager: SettingsManager.inMemory({
          compaction: {
            enabled: true,
            reserveTokens: 8192,
            keepRecentTokens: 12000,
          },
          retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 },
          packages: [],
          extensions: [],
          skills: [],
          prompts: [],
          enableSkillCommands: false,
          enableAnalytics: false,
          enableInstallTelemetry: false,
        }),
        resourceLoader: isolatedLoader(async (event) => ({
          compaction: await compact(
            event.preparation,
            model,
            cfg.apiKey || "local-no-key",
            undefined,
            COMPACTION_INSTRUCTIONS,
            event.signal,
            cfg.thinking || "off",
            (requestModel, context, options) =>
              runtime.streamSimple(requestModel, context, options),
          ),
        })),
        noTools: "builtin",
        tools: tools.map((tool) => tool.name),
        customTools: tools,
      });
    return { cfg, runtime, model, manager, session };
  }

  async compact(sessionId: string, instructions = COMPACTION_INSTRUCTIONS) {
    const { session } = await this.createSession(sessionId);
    try {
      await session.compact(instructions);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("Nothing to compact"))
        return false;
      throw error;
    } finally {
      session.dispose();
    }
  }

  async run(input: Parameters<AgentRuntime["run"]>[0]) {
    const { cfg, manager, session } = await this.createSession(
      input.sessionId,
      input.tools,
    );
    const abort = () => {
      void session.abort();
    };
    input.signal.addEventListener("abort", abort, { once: true });
    let eventError: unknown;
    const unsub = session.subscribe((e) => {
      if (e.type === "turn_start")
        try {
          input.onTurn();
        } catch (err) {
          eventError = err;
          abort();
        }
    });
    try {
      if (input.signal.aborted) throw new Error("CANCELLED");
      const usage = session.getContextUsage();
      if (usage && usage.percent !== null && usage.percent > 65)
        try {
          await session.compact(COMPACTION_INSTRUCTIONS);
        } catch (error) {
          // A single very large turn has no older turn boundary to compact yet.
          if (
            !(error instanceof Error) ||
            !error.message.includes("Nothing to compact")
          )
            throw error;
        }
      await session.prompt(input.context, { expandPromptTemplates: false });
      if (eventError) throw eventError;
      if (input.signal.aborted) throw new Error("CANCELLED");
      return {
        sessionEntryId: manager.getLeafId(),
        tokenUsage: session.getSessionStats().tokens,
        model: cfg.model,
        assistantText: session.getLastAssistantText(),
      };
    } finally {
      unsub();
      input.signal.removeEventListener("abort", abort);
      session.dispose();
    }
  }
}
