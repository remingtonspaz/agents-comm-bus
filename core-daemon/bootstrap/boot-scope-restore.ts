import { access } from "node:fs/promises";
import { join } from "node:path";

import type { AgentId, AuditStore, Storage } from "agents-comm-bus-core";

import { normalizeProjectPath } from "../project-path.js";
import { normalizeDaemonRootPath } from "../paths.js";
import type { EnsureCommsForSession } from "../runtime/agent-bridge.js";
import {
  classifySessionOwnerProcess,
  DEFAULT_SESSION_OWNER_RECENCY_MS,
  defaultIsPidAlive,
} from "../runtime/session-owner-liveness.js";

/** Default recency window for boot-time scope restore (24 hours). */
export const DEFAULT_BOOT_RESTORE_RECENCY_MS =
  DEFAULT_SESSION_OWNER_RECENCY_MS;

export interface BootScopeRestoreSummary {
  status: "skipped_paused" | "completed";
  candidates: number;
  restored: number;
  skipped_dead: number;
  skipped_stale: number;
  skipped_no_owner: number;
  skipped_no_daemon_owner: number;
  skipped_foreign_owner: number;
}

export interface BootScopeRestoreInput {
  stateRoot: string;
  discoveryRoot: string;
  storage: Storage;
  ensureCommsForSession: EnsureCommsForSession;
  audit?: AuditStore;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  recencyMs?: number;
  pathExists?: (path: string) => Promise<boolean>;
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function scopeDedupeKey(
  agent: AgentId | string,
  project: string,
  accountLabelScope?: string | null,
): string {
  return `${agent}:${normalizeProjectPath(project)}:${accountLabelScope ?? ""}`;
}

function classifySessionDaemonOwner(
  session: { lease_owner_daemon_discovery_root: string | null },
  currentDiscoveryRoot: string,
): "match" | "missing" | "foreign" {
  const stamped = session.lease_owner_daemon_discovery_root;
  if (stamped == null || stamped.length === 0) return "missing";
  return normalizeDaemonRootPath(stamped) === normalizeDaemonRootPath(currentDiscoveryRoot)
    ? "match"
    : "foreign";
}

async function auditBootRestore(
  audit: AuditStore | undefined,
  timestamp: number,
  summary: BootScopeRestoreSummary,
  error?: unknown,
): Promise<void> {
  if (!audit) return;
  const detail: Record<string, unknown> = { ...summary };
  if (error !== undefined) {
    detail.error = error instanceof Error ? error.message : String(error);
  }
  await audit
    .append({
      timestamp,
      kind: "daemon_boot_restore",
      detail,
    })
    .catch(() => {});
}

/**
 * AGE-55: on daemon boot, re-ensure comm scopes whose host owner process is
 * still alive. Best-effort and idempotent — never throws to the caller.
 */
export async function runBootScopeRestore(
  input: BootScopeRestoreInput,
): Promise<BootScopeRestoreSummary> {
  const now = input.now ?? (() => Date.now());
  const isPidAlive = input.isPidAlive ?? defaultIsPidAlive;
  const recencyMs = input.recencyMs ?? DEFAULT_BOOT_RESTORE_RECENCY_MS;
  const pathExists = input.pathExists ?? defaultPathExists;

  const summary: BootScopeRestoreSummary = {
    status: "completed",
    candidates: 0,
    restored: 0,
    skipped_dead: 0,
    skipped_stale: 0,
    skipped_no_owner: 0,
    skipped_no_daemon_owner: 0,
    skipped_foreign_owner: 0,
  };

  try {
    const pausedPath = join(input.stateRoot, "paused");
    if (await pathExists(pausedPath)) {
      summary.status = "skipped_paused";
      console.error(
        "agents-comm-bus: boot scope restore skipped (paused marker present)",
      );
      await auditBootRestore(input.audit, now(), summary);
      return summary;
    }

    const sessions = await input.storage.listSessions({ status: "active" });
    summary.candidates = sessions.length;

    const scopesToRestore = new Map<
      string,
      { project: string; agent: AgentId; accountLabelScope: string | null }
    >();

    for (const session of sessions) {
      const ownerState = classifySessionOwnerProcess(session, {
        now,
        isPidAlive,
        recencyMs,
      });
      switch (ownerState) {
        case "no_owner":
          summary.skipped_no_owner += 1;
          continue;
        case "stale":
          summary.skipped_stale += 1;
          continue;
        case "dead":
          summary.skipped_dead += 1;
          continue;
        case "live":
          break;
      }

      const ownerClass = classifySessionDaemonOwner(session, input.discoveryRoot);
      if (ownerClass === "missing") {
        summary.skipped_no_daemon_owner += 1;
        continue;
      }
      if (ownerClass === "foreign") {
        summary.skipped_foreign_owner += 1;
        continue;
      }

      // TODO(AGE-55): compare process start time against registeredAt to detect
      // pid reuse within the recency window. No clean cross-platform API from
      // Node built-ins — accepted-narrow v1 residual; worst case re-ensures an
      // idempotent comm adapter for a defunct session (recoverable, not destructive).

      const canonicalProject = normalizeProjectPath(session.project);
      const key = scopeDedupeKey(session.agent, canonicalProject, session.account_label_scope);
      if (!scopesToRestore.has(key)) {
        scopesToRestore.set(key, {
          project: canonicalProject,
          agent: session.agent,
          accountLabelScope: session.account_label_scope,
        });
      }
    }

    for (const scope of scopesToRestore.values()) {
      try {
        await input.ensureCommsForSession(scope.project, scope.agent, {
          accountLabelScope: scope.accountLabelScope,
        });
        summary.restored += 1;
      } catch (error) {
        console.error(
          `agents-comm-bus: boot scope restore ensure failed for ` +
            `${scope.project}/${scope.agent}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    console.error(
      "agents-comm-bus: boot scope restore complete: " +
        `candidates=${summary.candidates} restored=${summary.restored} ` +
        `skipped_dead=${summary.skipped_dead} skipped_stale=${summary.skipped_stale} ` +
        `skipped_no_owner=${summary.skipped_no_owner} ` +
        `skipped_no_daemon_owner=${summary.skipped_no_daemon_owner} ` +
        `skipped_foreign_owner=${summary.skipped_foreign_owner}`,
    );
    await auditBootRestore(input.audit, now(), summary);
    return summary;
  } catch (error) {
    console.error(
      "agents-comm-bus: boot scope restore failed: " +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    await auditBootRestore(input.audit, now(), summary, error);
    return summary;
  }
}
