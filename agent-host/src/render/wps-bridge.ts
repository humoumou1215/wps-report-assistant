import { AppError } from "../../../shared/contracts/index.js";
import type { RenderCapability } from "./capabilities.js";
import type { RenderPlan, TargetLocator, TargetSnapshot } from "../../../shared/contracts/index.js";
import { id, now } from "../project/store.js";

export type WpsCommand = {
  requestId: string;
  documentId: string;
  action: "capture" | "read" | "inspect" | "apply" | "restore";
  target: TargetLocator;
  plan?: RenderPlan;
  snapshot?: TargetSnapshot;
};

type Pending = {
  command: WpsCommand;
  resolve: (value: any) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type DocumentBridge = {
  documentKey: string;
  capabilities: string[];
  lastSeenAt: number;
  queue: WpsCommand[];
  waiters: Array<(command: WpsCommand | null) => void>;
};

export class WpsBridge {
  private documents = new Map<string, DocumentBridge>();
  private pending = new Map<string, Pending>();
  constructor(private timeoutMs = 45000, private staleMs = 60000) {}

  register(documentId: string, documentKey: string, capabilities: string[]) {
    let bridge = this.documents.get(documentId);
    if (!bridge) {
      bridge = { documentKey, capabilities: [], lastSeenAt: Date.now(), queue: [], waiters: [] };
      this.documents.set(documentId, bridge);
    }
    if (bridge.documentKey !== documentKey) throw new AppError("DOCUMENT_CHANGED", "WPS 桥接文档身份不匹配", 409);
    bridge.capabilities = [...new Set(capabilities.filter((value) => typeof value === "string"))];
    bridge.lastSeenAt = Date.now();
    return { connected: true, documentId, capabilities: bridge.capabilities, lastSeenAt: now() };
  }

  async next(documentId: string, waitMs = 20000): Promise<WpsCommand | null> {
    const bridge = this.documents.get(documentId);
    if (!bridge || Date.now() - bridge.lastSeenAt > this.staleMs) return null;
    bridge.lastSeenAt = Date.now();
    const command = bridge.queue.shift();
    if (command) return command;
    return new Promise((resolve) => {
      const finish = (value: WpsCommand | null) => {
        clearTimeout(timer);
        const index = bridge.waiters.indexOf(finish);
        if (index >= 0) bridge.waiters.splice(index, 1);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), Math.max(1, Math.min(30000, waitMs)));
      bridge.waiters.push(finish);
    });
  }

  respond(documentId: string, requestId: string, result?: any, error?: string) {
    const pending = this.pending.get(requestId);
    if (!pending || pending.command.documentId !== documentId) throw new AppError("BRIDGE_REQUEST_NOT_FOUND", "WPS 桥接请求不存在", 404);
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    const bridge = this.documents.get(documentId);
    if (bridge) bridge.lastSeenAt = Date.now();
    if (error) pending.reject(new AppError("WPS_ADAPTER_ERROR", error, 422));
    else pending.resolve(result);
    return { ok: true };
  }

  async call(documentId: string, action: WpsCommand["action"], target: TargetLocator, payload: { plan?: RenderPlan; snapshot?: TargetSnapshot } = {}) {
    const bridge = this.documents.get(documentId);
    if (!bridge || Date.now() - bridge.lastSeenAt > this.staleMs) throw new AppError("WPS_BRIDGE_OFFLINE", "请在目标 WPS 文件中打开数据报告助手", 503);
    if (!bridge.capabilities.includes(target.capabilityId)) throw new AppError("CAPABILITY_UNAVAILABLE", "当前 WPS 适配器未注册该 Render 能力", 422);
    const requestId = id();
    const command: WpsCommand = { requestId, documentId, action, target, ...payload };
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new AppError("WPS_BRIDGE_TIMEOUT", "等待 WPS 文档操作超时", 504));
      }, this.timeoutMs);
      this.pending.set(requestId, { command, resolve, reject, timer });
      const waiter = bridge.waiters.shift();
      if (waiter) waiter(command);
      else bridge.queue.push(command);
    });
  }

  async read(documentId: string, target: TargetLocator) {
    return this.call(documentId, "read", target);
  }

  async inspectDocument(documentId: string) {
    const bridge = this.documents.get(documentId);
    if (!bridge || Date.now() - bridge.lastSeenAt > this.staleMs) throw new AppError("WPS_BRIDGE_OFFLINE", "请在目标 WPS 文件中打开数据报告助手", 503);
    const capabilityId = bridge.capabilities[0];
    if (!capabilityId) throw new AppError("CAPABILITY_UNAVAILABLE", "当前 WPS 没有可用适配器", 422);
    return this.call(documentId, "inspect", { capabilityId, documentId, locator: {} });
  }

  capability(id: string): RenderCapability {
    return {
      id,
      reversible: true,
      capture: async (target) => this.call(target.documentId!, "capture", target),
      apply: async (target, plan) => { await this.call(target.documentId!, "apply", target, { plan }); },
      restore: async (target, snapshot) => { await this.call(target.documentId!, "restore", target, { snapshot }); },
    };
  }
}
