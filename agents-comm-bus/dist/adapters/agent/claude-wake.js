import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
export function hashProjectKey(projectPath) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < projectPath.length; i += 1) {
        hash ^= projectPath.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}
export function claudeWakeDirForProject(projectPath, homeDir = os.homedir()) {
    const resolved = path.resolve(projectPath);
    const basename = path.basename(resolved) || "project";
    return path.join(homeDir, ".agents-comm-bus", "claude-wake", "sessions", `${basename}-${hashProjectKey(resolved)}`);
}
export async function writeClaudeWakeTrigger(wakeDir, now = Date.now) {
    await mkdir(wakeDir, { recursive: true });
    await writeFile(path.join(wakeDir, "trigger-enter"), `${now()}\n`, "utf8");
}
export async function writeClaudeWakeResponse(wakeDir, payload) {
    await mkdir(wakeDir, { recursive: true });
    await writeFile(path.join(wakeDir, "permission-response.json"), JSON.stringify(payload), "utf8");
}
export class ClaudeWakeRegistry {
    now;
    registrations = new Map();
    constructor(now = Date.now) {
        this.now = now;
    }
    register(input) {
        const registration = {
            session: input.session,
            project: path.resolve(input.project),
            wakeDir: input.wakeDir ?? claudeWakeDirForProject(input.project),
            registeredAt: this.now(),
        };
        this.registrations.set(input.session, registration);
        return registration;
    }
    latestForProject(project) {
        const resolved = path.resolve(project);
        let latest;
        for (const registration of this.registrations.values()) {
            if (registration.project !== resolved)
                continue;
            if (!latest || registration.registeredAt > latest.registeredAt) {
                latest = registration;
            }
        }
        return latest;
    }
    getForSession(session) {
        return this.registrations.get(session);
    }
    async writeResponseForSession(session, payload) {
        const registration = this.registrations.get(session);
        if (!registration)
            return false;
        await writeClaudeWakeResponse(registration.wakeDir, payload);
        await writeClaudeWakeTrigger(registration.wakeDir, this.now);
        return true;
    }
    async wakeConversation(conversation) {
        if (conversation.agent !== "claude")
            return false;
        const registration = this.latestForProject(conversation.project);
        if (!registration)
            return false;
        await writeClaudeWakeTrigger(registration.wakeDir, this.now);
        return true;
    }
}
//# sourceMappingURL=claude-wake.js.map