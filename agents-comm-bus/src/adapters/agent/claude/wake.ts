import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentId, Conversation, SessionId } from "../../../../../agents-comm-bus-core/dist/index.js";

export interface ClaudeWakeRegistration {
  session: SessionId;
  project: string;
  wakeDir: string;
  registeredAt: number;
}

export function hashProjectKey(projectPath: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < projectPath.length; i += 1) {
    hash ^= projectPath.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function claudeWakeDirForProject(
  projectPath: string,
  homeDir = os.homedir(),
): string {
  const resolved = path.resolve(projectPath);
  const basename = path.basename(resolved) || "project";
  return path.join(
    homeDir,
    ".agents-comm-bus",
    "claude-wake",
    "sessions",
    `${basename}-${hashProjectKey(resolved)}`,
  );
}

export async function writeClaudeWakeTrigger(
  wakeDir: string,
  now: () => number = Date.now,
): Promise<void> {
  await mkdir(wakeDir, { recursive: true });
  await writeFile(path.join(wakeDir, "trigger-enter"), `${now()}\n`, "utf8");
}

export type ClaudeWakeResponsePromptType = "permission" | "question" | "freetext";

export interface ClaudeWakeResponsePayload {
  response: string;
  prompt_type: ClaudeWakeResponsePromptType;
}

export async function writeClaudeWakeResponse(
  wakeDir: string,
  payload: ClaudeWakeResponsePayload,
): Promise<void> {
  await mkdir(wakeDir, { recursive: true });
  await writeFile(
    path.join(wakeDir, "permission-response.json"),
    JSON.stringify(payload),
    "utf8",
  );
}

export class ClaudeWakeRegistry {
  private readonly registrations = new Map<SessionId, ClaudeWakeRegistration>();

  constructor(private readonly now: () => number = Date.now) {}

  register(input: {
    session: SessionId;
    project: string;
    wakeDir?: string;
  }): ClaudeWakeRegistration {
    const registration: ClaudeWakeRegistration = {
      session: input.session,
      project: path.resolve(input.project),
      wakeDir: input.wakeDir ?? claudeWakeDirForProject(input.project),
      registeredAt: this.now(),
    };
    this.registrations.set(input.session, registration);
    return registration;
  }

  latestForProject(project: string): ClaudeWakeRegistration | undefined {
    const resolved = path.resolve(project);
    let latest: ClaudeWakeRegistration | undefined;
    for (const registration of this.registrations.values()) {
      if (registration.project !== resolved) continue;
      if (!latest || registration.registeredAt > latest.registeredAt) {
        latest = registration;
      }
    }
    return latest;
  }

  getForSession(session: SessionId): ClaudeWakeRegistration | undefined {
    return this.registrations.get(session);
  }

  async writeResponseForSession(
    session: SessionId,
    payload: ClaudeWakeResponsePayload,
  ): Promise<boolean> {
    const registration = this.registrations.get(session);
    if (!registration) return false;
    await writeClaudeWakeResponse(registration.wakeDir, payload);
    await writeClaudeWakeTrigger(registration.wakeDir, this.now);
    return true;
  }

  async wakeConversation(conversation: Conversation): Promise<boolean> {
    if (conversation.agent !== ("claude" as AgentId)) return false;
    const registration = this.latestForProject(conversation.project);
    if (!registration) return false;
    await writeClaudeWakeTrigger(registration.wakeDir, this.now);
    return true;
  }
}
