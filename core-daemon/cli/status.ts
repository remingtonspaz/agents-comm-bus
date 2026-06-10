import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { LeaseRecord } from "../runtime/comm-lease.js";
import { commLeasePath } from "../runtime/comm-lease.js";
import { DAEMON_VERSION } from "../config.js";
import { connectIpc } from "../ipc/client.js";
import type { DaemonStatusSummary } from "../daemon.js";
import { openSqliteStorage } from "../storage/sqlite.js";
import { resolveDiscoveryPaths, resolveStatePaths } from "../paths.js";

export interface DaemonStatusSnapshot {
  daemon: {
    reachable: boolean;
    pid?: number;
    port?: number;
    version?: string;
    protocol_version?: string;
    reason?: string;
  };
  runtime?: DaemonStatusSummary;
  comm_leases: Array<{
    comm: string;
    resource_id: string;
    pid: number;
    authority_rank: string;
  }>;
  conversations: Array<{
    conversation_id: string;
    agent: string;
    comm: string;
    chat_native_id: string;
    last_inbound_at: number | null;
    last_outbound_at: number | null;
  }>;
  watchers: Array<{
    session_key: string;
    pid: number | null;
  }>;
}

export async function daemonStatus(options: {
  stateRoot?: string;
  discoveryRoot?: string;
  timeoutMs?: number;
} = {}): Promise<DaemonStatusSnapshot> {
  const statePaths = resolveStatePaths({
    stateRoot: options.stateRoot ?? process.env.AGENTS_COMM_BUS_STATE_ROOT,
  });
  const discoveryPaths = resolveDiscoveryPaths({
    stateRoot: statePaths.root,
    discoveryRoot: options.discoveryRoot ?? process.env.AGENTS_COMM_BUS_DISCOVERY_ROOT,
  });

  const pid = await readPidFile(discoveryPaths.pidFile);
  const port = await readPortFile(discoveryPaths.portFile);
  const commLeases = await listCommLeasesForPid(pid);
  const conversations = await listRecentConversations(statePaths.database);
  const watchers = await listWatcherPids(statePaths.root);

  if (port === undefined) {
    return {
      daemon: {
        reachable: false,
        pid,
        reason: pid === undefined ? "daemon not running (no pid/port files)" : "daemon not running (stale port file)",
      },
      comm_leases: commLeases,
      conversations,
      watchers,
    };
  }

  const timeoutMs = options.timeoutMs ?? 2_000;
  let connection: Awaited<ReturnType<typeof connectIpc>> | null = null;
  try {
    connection = await connectIpc({
      port,
      clientVersion: DAEMON_VERSION,
      timeoutMs,
      metadata: { shimName: "agents-comm-bus/cli", operation: "daemon_status" },
    });
    const runtime = (await connection.request("daemon_status", {})) as DaemonStatusSummary;
    return {
      daemon: {
        reachable: true,
        pid,
        port,
        version: connection.hello.daemonVersion,
        protocol_version: connection.hello.protocolVersion,
      },
      runtime,
      comm_leases: commLeases,
      conversations,
      watchers,
    };
  } catch (error) {
    return {
      daemon: {
        reachable: false,
        pid,
        port,
        reason: error instanceof Error ? error.message : String(error),
      },
      comm_leases: commLeases,
      conversations,
      watchers,
    };
  } finally {
    connection?.close();
  }
}

export function formatDaemonStatus(snapshot: DaemonStatusSnapshot): string {
  const lines: string[] = ["agents-comm-bus status", ""];

  if (snapshot.daemon.reachable) {
    lines.push(
      `daemon: up (pid ${snapshot.daemon.pid ?? "?"}, port ${snapshot.daemon.port ?? "?"}, ` +
        `version ${snapshot.daemon.version ?? "?"}, protocol ${snapshot.daemon.protocol_version ?? "?"})`,
    );
    if (snapshot.runtime) {
      lines.push(
        `runtime: pendingInbound=${snapshot.runtime.pending_inbound_depth}, ` +
          `active_scopes=${snapshot.runtime.active_scope_count}, ` +
          `live_adapters=${snapshot.runtime.live_adapters.length}`,
      );
      if (snapshot.runtime.live_adapters.length > 0) {
        lines.push(`  adapters: ${snapshot.runtime.live_adapters.join(", ")}`);
      }
    }
  } else {
    lines.push(`daemon: down (${snapshot.daemon.reason ?? "unreachable"})`);
    if (snapshot.daemon.pid !== undefined) {
      lines.push(`  pid file: ${snapshot.daemon.pid} (process may be stale)`);
    }
    if (snapshot.daemon.port !== undefined) {
      lines.push(`  port file: ${snapshot.daemon.port}`);
    }
  }

  lines.push("");
  lines.push(`comm leases (this pid): ${snapshot.comm_leases.length}`);
  for (const lease of snapshot.comm_leases.slice(0, 10)) {
    lines.push(`  ${lease.comm}/${lease.resource_id} rank=${lease.authority_rank} pid=${lease.pid}`);
  }
  if (snapshot.comm_leases.length > 10) {
    lines.push(`  ... +${snapshot.comm_leases.length - 10} more`);
  }

  lines.push("");
  lines.push(`recent conversations: ${snapshot.conversations.length}`);
  for (const row of snapshot.conversations.slice(0, 10)) {
    lines.push(
      `  ${row.agent}/${row.comm} chat=${row.chat_native_id} ` +
        `in=${formatTs(row.last_inbound_at)} out=${formatTs(row.last_outbound_at)}`,
    );
  }
  if (snapshot.conversations.length > 10) {
    lines.push(`  ... +${snapshot.conversations.length - 10} more`);
  }

  lines.push("");
  lines.push(`claude watchers: ${snapshot.watchers.length}`);
  for (const watcher of snapshot.watchers.slice(0, 10)) {
    lines.push(`  ${watcher.session_key}: pid=${watcher.pid ?? "missing"}`);
  }
  if (snapshot.watchers.length > 10) {
    lines.push(`  ... +${snapshot.watchers.length - 10} more`);
  }

  return lines.join("\n");
}

async function readPidFile(pidFile: string): Promise<number | undefined> {
  try {
    const raw = (await readFile(pidFile, "utf8")).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function readPortFile(portFile: string): Promise<number | undefined> {
  try {
    const raw = (await readFile(portFile, "utf8")).trim();
    const port = Number(raw);
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
  } catch {
    return undefined;
  }
}

async function listCommLeasesForPid(
  pid: number | undefined,
): Promise<DaemonStatusSnapshot["comm_leases"]> {
  if (pid === undefined) return [];
  const locksRoot = path.join(os.homedir(), ".agents-comm-bus", "comm-locks");
  const out: DaemonStatusSnapshot["comm_leases"] = [];
  let commDirs: string[];
  try {
    commDirs = await readdir(locksRoot);
  } catch {
    return out;
  }
  for (const comm of commDirs) {
    const commDir = path.join(locksRoot, comm);
    let files: string[];
    try {
      files = await readdir(commDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = path.join(commDir, file);
      try {
        const record = JSON.parse(await readFile(filePath, "utf8")) as LeaseRecord;
        if (record.pid !== pid) continue;
        out.push({
          comm: record.comm_id,
          resource_id: record.resource_id,
          pid: record.pid,
          authority_rank: record.authorityRank,
        });
      } catch {
        // ignore unreadable lease files
      }
    }
  }
  return out;
}

async function listRecentConversations(
  databasePath: string,
): Promise<DaemonStatusSnapshot["conversations"]> {
  try {
    const storage = await openSqliteStorage(databasePath);
    const rows = await storage.listConversations({ limit: 25 });
    return rows.map((row) => ({
      conversation_id: row.conversation_id,
      agent: row.agent,
      comm: row.comm,
      chat_native_id: row.chat_native_id,
      last_inbound_at: row.last_inbound_at,
      last_outbound_at: row.last_outbound_at,
    }));
  } catch {
    return [];
  }
}

async function listWatcherPids(
  stateRoot: string,
): Promise<DaemonStatusSnapshot["watchers"]> {
  const sessionsDir = path.join(stateRoot, "claude-wake", "sessions");
  const out: DaemonStatusSnapshot["watchers"] = [];
  let sessionDirs: string[];
  try {
    sessionDirs = await readdir(sessionsDir);
  } catch {
    return out;
  }
  for (const sessionKey of sessionDirs) {
    const pidFile = path.join(sessionsDir, sessionKey, "watcher.pid");
    try {
      const raw = (await readFile(pidFile, "utf8")).trim();
      const pid = Number(raw);
      out.push({
        session_key: sessionKey,
        pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      });
    } catch {
      out.push({ session_key: sessionKey, pid: null });
    }
  }
  return out;
}

function formatTs(value: number | null): string {
  if (value == null) return "-";
  return new Date(value).toISOString();
}

// Exported for tests that assert lease path resolution matches runtime.
export function leasePathFor(comm: string, resourceId: string, homeDir = os.homedir()): string {
  return commLeasePath(comm, resourceId, homeDir);
}
