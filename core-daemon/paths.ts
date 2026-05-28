import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { DAEMON_NAME } from "./config.js";

export interface StatePathOptions {
  homeDir?: string;
  stateRoot?: string;
}

export interface ConversationPathOptions extends StatePathOptions {
  conversationId: string;
}

export interface AgentsCommBusPaths {
  root: string;
  database: string;
  databaseWal: string;
  databaseShm: string;
  auditDir: string;
  chatsDir: string;
  tokensDir: string;
  pidFile: string;
  portFile: string;
  spawnLock: string;
}

export interface ConversationPaths {
  conversationDir: string;
  transcript: string;
  attachmentsDir: string;
}

export interface TokenFilePathOptions extends StatePathOptions {
  comm: string;
  project: string;
  agent: string;
  accountId: string;
}

export function stateRoot(options: StatePathOptions = {}): string {
  return path.resolve(options.stateRoot ?? path.join(options.homeDir ?? os.homedir(), `.${DAEMON_NAME}`));
}

export function resolveStatePaths(options: StatePathOptions = {}): AgentsCommBusPaths {
  const root = stateRoot(options);
  const database = path.join(root, `${DAEMON_NAME}.db`);

  return {
    root,
    database,
    databaseWal: `${database}-wal`,
    databaseShm: `${database}-shm`,
    auditDir: path.join(root, "audit"),
    chatsDir: path.join(root, "chats"),
    tokensDir: path.join(root, "tokens"),
    pidFile: path.join(root, "daemon.pid"),
    portFile: path.join(root, "port"),
    spawnLock: path.join(root, ".spawn.lock"),
  };
}

export function resolveConversationPaths(options: ConversationPathOptions): ConversationPaths {
  const paths = resolveStatePaths(options);
  const safeConversationId = encodeURIComponent(options.conversationId);
  const conversationDir = path.join(paths.chatsDir, safeConversationId);

  return {
    conversationDir,
    transcript: path.join(conversationDir, "transcript.jsonl"),
    attachmentsDir: path.join(conversationDir, "attachments"),
  };
}

export function resolveTokenFilePath(options: TokenFilePathOptions): string {
  const paths = resolveStatePaths(options);
  const project = path.resolve(options.project);
  const projectBase = safePathSegment(path.basename(project) || "project");
  const projectHash = createHash("sha256").update(project).digest("hex").slice(0, 12);
  return path.join(
    paths.tokensDir,
    safePathSegment(options.comm),
    `${projectBase}-${projectHash}`,
    safePathSegment(options.agent),
    `${safePathSegment(options.accountId)}.json`,
  );
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
}
