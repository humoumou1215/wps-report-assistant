import type { RenderPlan, TargetLocator, TargetSnapshot } from "../../../shared/contracts/index.js";
import { AppError } from "../../../shared/contracts/index.js";

export interface RenderCapability<TPlan extends RenderPlan = RenderPlan, TSnapshot extends TargetSnapshot = TargetSnapshot> {
  id: string;
  reversible: boolean;
  capture(target: TargetLocator): Promise<TSnapshot>;
  apply(target: TargetLocator, plan: TPlan): Promise<void>;
  restore(target: TargetLocator, snapshot: TSnapshot): Promise<void>;
  verify?(target: TargetLocator, expected: TPlan, actual: TSnapshot): Promise<import("../../../shared/contracts/index.js").ProgramVerification>;
}
export class CapabilityRegistry {
  private capabilities = new Map<string, RenderCapability>();
  register(capability: RenderCapability) {
    if (!capability.id || this.capabilities.has(capability.id)) throw new AppError("CAPABILITY_CONFLICT", "Render 能力 ID 重复", 409);
    this.capabilities.set(capability.id, capability);
    return capability;
  }
  resolve(target: TargetLocator) {
    const capability = this.capabilities.get(target.capabilityId);
    if (!capability) throw new AppError("CAPABILITY_UNAVAILABLE", `未注册 Render 能力：${target.capabilityId}`, 422);
    return capability;
  }
}
