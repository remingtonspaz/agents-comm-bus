import type { CodexAppServerClient } from "./app-server.js";
import { liveThreadsMatchingProject } from "./app-server.js";

export type CodexWakeTargetProbeResult =
  | { ok: true; appServerUrl: string; threadId: string; scanned: number }
  | {
      ok: false;
      reason: "probe_no_match" | "probe_ambiguous";
      scanned: number;
      matches: number;
      ports?: number[];
    };

export interface ProbeCodexWakeTargetByCwdInput {
  project: string;
  portRange: { min: number; max: number };
  clientFactory: (url: string) => CodexAppServerClient;
  perProbeTimeoutMs?: number;
  concurrency?: number;
}

export async function probeCodexWakeTargetByCwd(
  input: ProbeCodexWakeTargetByCwdInput,
): Promise<CodexWakeTargetProbeResult> {
  const { min, max } = input.portRange;
  const perProbeTimeoutMs = input.perProbeTimeoutMs ?? 300;
  const concurrency = input.concurrency ?? 10;
  const ports: number[] = [];
  for (let port = min; port <= max; port += 1) {
    ports.push(port);
  }

  const matches: Array<{ port: number; threadId: string; cwd: string }> = [];
  await mapWithConcurrency(ports, concurrency, async (port) => {
    const url = `ws://127.0.0.1:${port}`;
    const client = input.clientFactory(url);
    try {
      const listResult = await client.call("thread/list", {}, { timeoutMs: perProbeTimeoutMs });
      for (const thread of liveThreadsMatchingProject(listResult, input.project)) {
        matches.push({ port, ...thread });
      }
    } catch {
      // Unreachable port or timeout counts as no threads for that endpoint.
    }
  });

  const scanned = ports.length;
  if (matches.length === 0) {
    return { ok: false, reason: "probe_no_match", scanned, matches: 0 };
  }
  if (matches.length >= 2) {
    return {
      ok: false,
      reason: "probe_ambiguous",
      scanned,
      matches: matches.length,
      ports: [...new Set(matches.map((match) => match.port))],
    };
  }

  const match = matches[0]!;
  return {
    ok: true,
    appServerUrl: `ws://127.0.0.1:${match.port}`,
    threadId: match.threadId,
    scanned,
  };
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await fn(current!);
    }
  });
  await Promise.all(workers);
}
