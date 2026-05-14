import type { PermissionKind } from "./types.js";

export interface AgentCapabilities {
  canWake: boolean;
  canSteer: boolean;
  canInterrupt: boolean;
  midTurnPolicy: "queue" | "steer" | "reject";
  permissionKinds: PermissionKind[];
}

export interface CommCapabilities {
  canSendText: boolean;
  canSendAttachments: boolean;
  supportsThreads: boolean;
  supportsBots: boolean;
  bidirectionalBotMessaging: boolean;
  supportsReplyToMessage: boolean;
}

export function assertCapability<T extends Record<string, unknown>>(
  cap: T,
  key: keyof T,
): void {
  if (!cap[key]) {
    throw new Error(`Capability not supported: ${String(key)}`);
  }
}
