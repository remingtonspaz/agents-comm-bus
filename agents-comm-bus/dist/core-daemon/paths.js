import os from "node:os";
import path from "node:path";
import { DAEMON_NAME } from "./config.js";
export function stateRoot(options = {}) {
    return path.resolve(options.stateRoot ?? path.join(options.homeDir ?? os.homedir(), `.${DAEMON_NAME}`));
}
export function resolveStatePaths(options = {}) {
    const root = stateRoot(options);
    const database = path.join(root, `${DAEMON_NAME}.db`);
    return {
        root,
        database,
        databaseWal: `${database}-wal`,
        databaseShm: `${database}-shm`,
        auditDir: path.join(root, "audit"),
        chatsDir: path.join(root, "chats"),
        pidFile: path.join(root, "daemon.pid"),
        portFile: path.join(root, "port"),
        spawnLock: path.join(root, ".spawn.lock"),
    };
}
export function resolveConversationPaths(options) {
    const paths = resolveStatePaths(options);
    const safeConversationId = encodeURIComponent(options.conversationId);
    const conversationDir = path.join(paths.chatsDir, safeConversationId);
    return {
        conversationDir,
        transcript: path.join(conversationDir, "transcript.jsonl"),
        attachmentsDir: path.join(conversationDir, "attachments"),
    };
}
//# sourceMappingURL=paths.js.map