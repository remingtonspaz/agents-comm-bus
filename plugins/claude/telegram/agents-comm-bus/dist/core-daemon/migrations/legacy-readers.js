import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
export const TRANSITION_ONLY_MARKER = "transition-only";
export const TRANSITION_CLEANUP_RELEASE = "v4.1-cleanup";
export function legacySessionDirForProject(projectRoot, agent, homeDir = homedir()) {
    const normalizedProject = resolve(projectRoot);
    const safeBase = basename(normalizedProject).replace(/[^a-zA-Z0-9-_]/g, "_");
    const hash = createHash("md5").update(normalizedProject).digest("hex").slice(0, 6);
    return join(homeDir, agent === "claude" ? ".claude-telegram" : ".codex-telegram", `${safeBase}-${hash}`);
}
export function discoverLegacyInputs(options) {
    const projectRoot = resolve(options.projectRoot);
    const homeDir = options.homeDir ? resolve(options.homeDir) : homedir();
    const now = options.now ?? Date.now();
    const pendingTtlMs = options.pendingTtlMs ?? 5 * 60 * 1000;
    const skipped = [];
    const sessionRoots = discoverLegacySessionRoots(projectRoot, homeDir, skipped);
    const credentials = discoverCredentialCandidates(projectRoot, homeDir, skipped);
    const lastChats = [];
    const pendingPermissions = [];
    const queues = [];
    for (const root of sessionRoots) {
        const lastChat = readLastChat(join(root.path, "last-chat.json"), root.agent, root.path);
        if (lastChat.ok)
            lastChats.push(lastChat.file);
        else if (lastChat.exists)
            skipped.push(skip("last-chat", root.agent, join(root.path, "last-chat.json"), lastChat.reason));
        const pending = readPendingPermission(join(root.path, "pending-permission.json"), root.agent, root.path, now, pendingTtlMs);
        if (pending.ok)
            pendingPermissions.push(pending.file);
        else if (pending.exists)
            skipped.push(skip("pending-permission", root.agent, join(root.path, "pending-permission.json"), pending.reason));
        const queue = readQueue(join(root.path, "queue.json"), root.agent, root.path);
        if (queue.ok)
            queues.push(queue.file);
        else if (queue.exists)
            skipped.push(skip("queue", root.agent, join(root.path, "queue.json"), queue.reason));
    }
    return { projectRoot, homeDir, credentials, sessionRoots, lastChats, pendingPermissions, queues, skipped };
}
function discoverCredentialCandidates(projectRoot, homeDir, skipped) {
    const paths = [
        { agent: "claude", scope: "project", path: join(projectRoot, ".claude", "telegram.json"), priority: 10 },
        { agent: "codex", scope: "project", path: join(projectRoot, ".codex", "telegram.json"), priority: 10 },
        { agent: "claude", scope: "home", path: join(homeDir, ".claude", "telegram.json"), priority: 1 },
        { agent: "codex", scope: "home", path: join(homeDir, ".codex", "telegram.json"), priority: 1 },
    ];
    const result = [];
    for (const candidate of paths) {
        if (!existsSync(candidate.path))
            continue;
        const parsed = readJson(candidate.path);
        if (!parsed.ok) {
            skipped.push(skip("credential", candidate.agent, candidate.path, parsed.reason));
            continue;
        }
        if (!isObject(parsed.value)) {
            skipped.push(skip("credential", candidate.agent, candidate.path, "credential file is not a JSON object"));
            continue;
        }
        const botToken = stringValue(parsed.value.botToken);
        const userIds = normalizeUserIds(parsed.value.userId);
        result.push({
            kind: "credential",
            agent: candidate.agent,
            path: candidate.path,
            scope: candidate.scope,
            priority: candidate.priority,
            hasBotToken: botToken.length > 0,
            userIds,
            credentialRef: `legacy-file:${candidate.path}`,
            transition: TRANSITION_ONLY_MARKER,
            cleanupRelease: TRANSITION_CLEANUP_RELEASE,
        });
    }
    return result;
}
function discoverLegacySessionRoots(projectRoot, homeDir, skipped) {
    const roots = [];
    for (const agent of ["claude", "codex"]) {
        const parent = join(homeDir, agent === "claude" ? ".claude-telegram" : ".codex-telegram");
        if (!existsSync(parent))
            continue;
        let entries;
        try {
            entries = readdirSync(parent);
        }
        catch (error) {
            skipped.push(skip("session-root", agent, parent, error instanceof Error ? error.message : "cannot read session root"));
            continue;
        }
        const expected = legacySessionDirForProject(projectRoot, agent, homeDir);
        for (const entry of entries) {
            const path = join(parent, entry);
            let isDirectory = false;
            try {
                isDirectory = statSync(path).isDirectory();
            }
            catch {
                continue;
            }
            if (!isDirectory)
                continue;
            roots.push({
                kind: "session-root",
                agent,
                path,
                projectHint: entry.replace(/-[0-9a-f]{6}$/i, ""),
                expectedForProject: resolve(path) === resolve(expected),
                transition: TRANSITION_ONLY_MARKER,
                cleanupRelease: TRANSITION_CLEANUP_RELEASE,
            });
        }
    }
    return roots;
}
function readLastChat(path, agent, sessionRoot) {
    const parsed = readOptionalObject(path);
    if (!parsed.ok)
        return parsed;
    const chatId = stringValue(parsed.value.chat_id);
    if (!chatId)
        return { ok: false, exists: true, reason: "last-chat.json is missing chat_id" };
    return {
        ok: true,
        file: stateFile("last-chat", agent, path, sessionRoot, {
            chat_id: chatId,
            message_thread_id: nullableString(parsed.value.message_thread_id),
            from_user_id: nullableString(parsed.value.from_user_id),
            updated_at: nullableString(parsed.value.updated_at),
        }),
    };
}
function readPendingPermission(path, agent, sessionRoot, now, ttlMs) {
    const parsed = readOptionalObject(path);
    if (!parsed.ok)
        return parsed;
    const timestamp = stringValue(parsed.value.timestamp);
    if (!timestamp)
        return { ok: false, exists: true, reason: "pending-permission.json is missing timestamp" };
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs))
        return { ok: false, exists: true, reason: "pending-permission.json timestamp is invalid" };
    if (now - timestampMs >= ttlMs)
        return { ok: false, exists: true, reason: "pending permission is expired" };
    return {
        ok: true,
        file: stateFile("pending-permission", agent, path, sessionRoot, {
            timestamp,
            tool_name: nullableString(parsed.value.tool_name),
            tool_input: isObject(parsed.value.tool_input) ? parsed.value.tool_input : null,
            prompt_type: stringValue(parsed.value.prompt_type) || "permission",
            chat_id: nullableString(parsed.value.chat_id),
            message_thread_id: nullableString(parsed.value.message_thread_id),
        }),
    };
}
function readQueue(path, agent, sessionRoot) {
    const parsed = readOptionalObject(path);
    if (!parsed.ok)
        return parsed;
    const rawMessages = Array.isArray(parsed.value.messages) ? parsed.value.messages : [];
    const messages = [];
    for (const raw of rawMessages) {
        if (!isObject(raw))
            continue;
        messages.push({
            id: stringValue(raw.id),
            timestamp: typeof raw.timestamp === "number" || typeof raw.timestamp === "string" ? raw.timestamp : null,
            text: stringValue(raw.text),
            from: nullableString(raw.from),
            chatId: nullableString(raw.chatId),
            imagePath: nullableString(raw.imagePath) ?? undefined,
        });
    }
    return { ok: true, file: stateFile("queue", agent, path, sessionRoot, messages) };
}
function readOptionalObject(path) {
    if (!existsSync(path))
        return { ok: false, exists: false, reason: "file does not exist" };
    const parsed = readJson(path);
    if (!parsed.ok)
        return { ok: false, exists: true, reason: parsed.reason };
    if (!isObject(parsed.value))
        return { ok: false, exists: true, reason: "file is not a JSON object" };
    return { ok: true, value: parsed.value };
}
function readJson(path) {
    try {
        return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
    }
    catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : "invalid JSON" };
    }
}
function normalizeUserIds(raw) {
    const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    return values.map((value) => stringValue(value).trim()).filter(Boolean);
}
function stateFile(kind, agent, path, sessionRoot, value) {
    return {
        kind,
        agent,
        path,
        sessionRoot,
        value,
        transition: TRANSITION_ONLY_MARKER,
        cleanupRelease: TRANSITION_CLEANUP_RELEASE,
    };
}
function skip(kind, agent, path, reason) {
    return {
        kind,
        agent,
        path,
        reason,
        transition: TRANSITION_ONLY_MARKER,
        cleanupRelease: TRANSITION_CLEANUP_RELEASE,
    };
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue(value) {
    if (value == null)
        return "";
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean")
        return String(value);
    return "";
}
function nullableString(value) {
    const text = stringValue(value);
    return text.length > 0 ? text : null;
}
//# sourceMappingURL=legacy-readers.js.map