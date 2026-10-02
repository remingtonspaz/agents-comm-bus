import type { AgentId } from "agents-comm-bus-core";

import { normalizeProjectPath } from "../project-path.js";
import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";

export async function wakeModeSet(options: {
  agent: string;
  mode: "auto" | "native";
  project?: string;
}): Promise<{ ok: true }> {
  const storage = await openSqliteStorage(resolveStatePaths().database);
  try {
    const project =
      options.project && options.project.length > 0
        ? normalizeProjectPath(options.project)
        : "";
    await storage.setWakeMode(
      project,
      options.agent as AgentId,
      options.mode,
      Date.now(),
    );
    return { ok: true };
  } finally {
    await storage.close();
  }
}

export async function wakeModeGet(options: {
  agent: string;
  project?: string;
}): Promise<{
  ok: true;
  mode: "auto" | "native";
  source: { scope: "project" | "global" | "default"; project: string };
}> {
  const storage = await openSqliteStorage(resolveStatePaths().database);
  try {
    const project =
      options.project && options.project.length > 0
        ? normalizeProjectPath(options.project)
        : "";
    const mode = await storage.getWakeMode(project, options.agent as AgentId);
    const rows = await storage.listWakeModes();
    const scoped = rows.find(
      (row) => row.project === project && row.agent === options.agent,
    );
    const global = rows.find(
      (row) => row.project === "" && row.agent === options.agent,
    );
    const source = scoped
      ? { scope: "project" as const, project }
      : global
        ? { scope: "global" as const, project: "" }
        : { scope: "default" as const, project: "" };
    return { ok: true, mode, source };
  } finally {
    await storage.close();
  }
}

export async function wakeModeClear(options: {
  agent: string;
  project?: string;
}): Promise<{ ok: true }> {
  const storage = await openSqliteStorage(resolveStatePaths().database);
  try {
    const project =
      options.project && options.project.length > 0
        ? normalizeProjectPath(options.project)
        : "";
    await storage.clearWakeMode(project, options.agent as AgentId);
    return { ok: true };
  } finally {
    await storage.close();
  }
}

export async function wakeModeList(): Promise<{
  ok: true;
  rows: Array<{
    project: string;
    agent: AgentId;
    mode: "auto" | "native";
    updated_at: number;
  }>;
}> {
  const storage = await openSqliteStorage(resolveStatePaths().database);
  try {
    const rows = await storage.listWakeModes();
    return { ok: true, rows };
  } finally {
    await storage.close();
  }
}
