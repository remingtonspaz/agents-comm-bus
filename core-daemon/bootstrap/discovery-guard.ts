import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile, link } from "node:fs/promises";
import path from "node:path";

export interface DiscoveryGuardSelf {
  pid: number;
  startedAt: number | null;
}

export interface DiscoveryGuardToken {
  pid: number;
  startedAt: number | null;
  at: number;
  nonce: string;
}

export interface WithDiscoveryGuardOptions {
  maxWaitMs?: number;
  isPidAlive?: (pid: number) => boolean;
  /** Injectable clock for tests (defaults to Date.now). */
  now?: () => number;
  /** Test hook: invoked immediately before publishing the guard token via link. */
  beforeGuardLink?: () => Promise<void>;
  /** Test hook: invoked after a dead guard is verified and before reclaim-lock acquisition. */
  beforeReclaim?: () => Promise<void>;
  /** Test hook: invoked after validating a dead reclaim token and before reclaim2 acquisition. */
  beforeReclaim2?: () => Promise<void>;
  /** Test hook: invoked after the reclaim lock is held and before quarantining the main guard. */
  beforeQuarantine?: () => Promise<void>;
}

export type WithDiscoveryGuardResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "guard_contended" };

const GUARD_FILE = "owner.lock";
const RECLAIM_FILE = "owner.lock.reclaim";
const RECLAIM2_FILE = "owner.lock.reclaim2";
const RETRY_MS = 20;
const DEFAULT_MAX_WAIT_MS = 2_000;

let loggedDeadReclaim2Paths = new Set<string>();

export function discoveryGuardFile(discoveryRoot: string): string {
  return path.join(discoveryRoot, GUARD_FILE);
}

export function discoveryReclaimLockFile(discoveryRoot: string): string {
  return path.join(discoveryRoot, RECLAIM_FILE);
}

export function discoveryReclaim2LockFile(discoveryRoot: string): string {
  return path.join(discoveryRoot, RECLAIM2_FILE);
}

export function resetDiscoveryGuardTestState(): void {
  loggedDeadReclaim2Paths = new Set<string>();
}

export function parseDiscoveryGuardToken(raw: string): DiscoveryGuardToken | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Partial<DiscoveryGuardToken>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.at !== "number" ||
      !Number.isFinite(parsed.at)
    ) {
      return undefined;
    }
    const startedAt =
      parsed.startedAt === null || parsed.startedAt === undefined
        ? null
        : typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt)
          ? parsed.startedAt
          : undefined;
    if (startedAt === undefined && parsed.startedAt !== null && parsed.startedAt !== undefined) {
      return undefined;
    }
    const nonce = typeof parsed.nonce === "string" ? parsed.nonce : "";
    return { pid: parsed.pid, startedAt: startedAt ?? null, at: parsed.at, nonce };
  } catch {
    return undefined;
  }
}

export function guardTokensEqual(a: DiscoveryGuardToken, b: DiscoveryGuardToken): boolean {
  return (
    a.pid === b.pid &&
    a.startedAt === b.startedAt &&
    a.at === b.at &&
    a.nonce === b.nonce
  );
}

export async function withDiscoveryGuard<T>(
  discoveryRoot: string,
  self: DiscoveryGuardSelf,
  fn: () => Promise<T>,
  options: WithDiscoveryGuardOptions = {},
): Promise<WithDiscoveryGuardResult<T>> {
  await mkdir(discoveryRoot, { recursive: true });
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const deadline = Date.now() + (options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  let acquiredToken: string | undefined;

  while (Date.now() <= deadline) {
    const attempt = await tryAcquireGuard(discoveryRoot, self, isPidAlive, options);
    if (attempt.kind === "acquired") {
      acquiredToken = attempt.token;
      try {
        return { ok: true, value: await fn() };
      } finally {
        await releaseGuardIfTokenMatches(discoveryGuardFile(discoveryRoot), acquiredToken);
      }
    }
    if (attempt.kind === "contended") {
      await sleep(RETRY_MS);
      continue;
    }
    return { ok: false, reason: "guard_contended" };
  }

  return { ok: false, reason: "guard_contended" };
}

type AcquireAttempt =
  | { kind: "acquired"; token: string }
  | { kind: "contended" }
  | { kind: "failed" };

async function tryAcquireGuard(
  discoveryRoot: string,
  self: DiscoveryGuardSelf,
  isPidAlive: (pid: number) => boolean,
  options: WithDiscoveryGuardOptions,
): Promise<AcquireAttempt> {
  const reclaim2Raw = await readGuardRaw(discoveryReclaim2LockFile(discoveryRoot));
  if (reclaim2Raw !== null) {
    const reclaim2 = parseDiscoveryGuardToken(reclaim2Raw);
    if (reclaim2 && !isPidAlive(reclaim2.pid)) {
      logDeadReclaim2Once(discoveryReclaim2LockFile(discoveryRoot));
    }
    return { kind: "failed" };
  }

  const guardPath = discoveryGuardFile(discoveryRoot);
  const token = buildGuardToken(self, options.now);
  const published = await publishFileViaLink(guardPath, token, self.pid, options);
  if (published === "ok") {
    return { kind: "acquired", token };
  }

  const raw = await readGuardRaw(guardPath);
  if (raw === null) {
    return { kind: "contended" };
  }

  const existing = parseDiscoveryGuardToken(raw);
  // G2: unparsable/empty guard tokens are never stolen by age — keep waiting.
  if (!existing) {
    return { kind: "contended" };
  }

  // Own token is always contended while this process may still hold the guard.
  if (existing.pid === self.pid) {
    return { kind: "contended" };
  }

  if (isPidAlive(existing.pid)) {
    return { kind: "contended" };
  }

  await options.beforeReclaim?.();
  const reclaimed = await reclaimDeadGuard(discoveryRoot, self, existing, isPidAlive, options);
  return reclaimed ? { kind: "contended" } : { kind: "failed" };
}

/**
 * Dead-guard recovery runs under owner.lock.reclaim (G3'). Recovery of a dead
 * owner.lock.reclaim token runs only while holding owner.lock.reclaim2 (depth 2).
 * owner.lock.reclaim2 is never auto-reaped: if it exists at all, callers get
 * guard_contended (manual cleanup required — no depth 3).
 */
async function reclaimDeadGuard(
  discoveryRoot: string,
  self: DiscoveryGuardSelf,
  deadToken: DiscoveryGuardToken,
  isPidAlive: (pid: number) => boolean,
  options: WithDiscoveryGuardOptions,
): Promise<boolean> {
  const reclaimHeld = await tryAcquireReclaimLock(discoveryRoot, self, isPidAlive, options);
  if (!reclaimHeld) return false;

  try {
    await options.beforeQuarantine?.();
    return await quarantineVerifiedGuard(discoveryRoot, self, deadToken, options);
  } finally {
    await releaseGuardIfTokenMatches(discoveryReclaimLockFile(discoveryRoot), reclaimHeld);
  }
}

async function tryAcquireReclaimLock(
  discoveryRoot: string,
  self: DiscoveryGuardSelf,
  isPidAlive: (pid: number) => boolean,
  options: WithDiscoveryGuardOptions,
): Promise<string | undefined> {
  const reclaimPath = discoveryReclaimLockFile(discoveryRoot);
  const reclaimToken = buildGuardToken({ pid: self.pid, startedAt: self.startedAt }, options.now);
  if (await publishFileViaLink(reclaimPath, reclaimToken, self.pid, options) === "ok") {
    return reclaimToken;
  }

  const raw = await readGuardRaw(reclaimPath);
  if (!raw) return undefined;
  const existing = parseDiscoveryGuardToken(raw);
  if (!existing) return undefined;
  if (isPidAlive(existing.pid)) return undefined;

  await options.beforeReclaim2?.();
  const recovered = await recoverDeadReclaimLockUnderReclaim2(
    discoveryRoot,
    self,
    existing,
    isPidAlive,
    options,
  );
  if (!recovered) return undefined;

  const retryToken = buildGuardToken({ pid: self.pid, startedAt: self.startedAt }, options.now);
  if (await publishFileViaLink(reclaimPath, retryToken, self.pid, options) === "ok") {
    return retryToken;
  }
  return undefined;
}

async function recoverDeadReclaimLockUnderReclaim2(
  discoveryRoot: string,
  self: DiscoveryGuardSelf,
  expectedDeadToken: DiscoveryGuardToken,
  isPidAlive: (pid: number) => boolean,
  options: WithDiscoveryGuardOptions,
): Promise<boolean> {
  const reclaim2Path = discoveryReclaim2LockFile(discoveryRoot);
  const reclaim2Raw = await readGuardRaw(reclaim2Path);
  if (reclaim2Raw !== null) {
    const reclaim2 = parseDiscoveryGuardToken(reclaim2Raw);
    if (reclaim2 && !isPidAlive(reclaim2.pid)) {
      logDeadReclaim2Once(reclaim2Path);
    }
    return false;
  }

  const reclaim2Token = buildGuardToken({ pid: self.pid, startedAt: self.startedAt }, options.now);
  if (await publishFileViaLink(reclaim2Path, reclaim2Token, self.pid, options) !== "ok") {
    return false;
  }

  const reclaimPath = discoveryReclaimLockFile(discoveryRoot);
  try {
    const reread = await readGuardRaw(reclaimPath);
    const current = reread ? parseDiscoveryGuardToken(reread) : undefined;
    if (!current || !guardTokensEqual(current, expectedDeadToken)) {
      return false;
    }
    return await quarantineVerifiedGuardFile(reclaimPath, self, expectedDeadToken, options.now);
  } finally {
    await releaseGuardIfTokenMatches(reclaim2Path, reclaim2Token);
  }
}

function logDeadReclaim2Once(reclaim2Path: string): void {
  if (loggedDeadReclaim2Paths.has(reclaim2Path)) return;
  loggedDeadReclaim2Paths.add(reclaim2Path);
  console.error(`dead discovery reclaim2 token at ${reclaim2Path}; manual cleanup required`);
}

async function quarantineVerifiedGuard(
  discoveryRoot: string,
  self: DiscoveryGuardSelf,
  expectedDeadToken: DiscoveryGuardToken,
  options: WithDiscoveryGuardOptions,
): Promise<boolean> {
  return quarantineVerifiedGuardFile(
    discoveryGuardFile(discoveryRoot),
    self,
    expectedDeadToken,
    options.now,
  );
}

async function quarantineVerifiedGuardFile(
  guardPath: string,
  self: DiscoveryGuardSelf,
  expectedDeadToken: DiscoveryGuardToken,
  now?: () => number,
): Promise<boolean> {
  const raw = await readGuardRaw(guardPath);
  if (!raw) return false;
  const current = parseDiscoveryGuardToken(raw);
  if (!current || !guardTokensEqual(current, expectedDeadToken)) {
    return false;
  }

  const clock = now ?? Date.now;
  const stalePath = `${guardPath}.stale.${self.pid}.${clock()}`;
  try {
    await rename(guardPath, stalePath);
  } catch {
    return false;
  }
  await rm(stalePath, { force: true });
  return true;
}

async function publishFileViaLink(
  targetPath: string,
  content: string,
  selfPid: number,
  options: Pick<WithDiscoveryGuardOptions, "now" | "beforeGuardLink"> = {},
): Promise<"ok" | "eexist"> {
  const clock = options.now ?? Date.now;
  const tempPath = `${targetPath}.tmp.${selfPid}.${clock()}.${randomUUID()}`;
  try {
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    await options.beforeGuardLink?.();
    try {
      await link(tempPath, targetPath);
      return "ok";
    } catch (error) {
      if (isAlreadyExistsError(error)) return "eexist";
      throw error;
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

function buildGuardToken(self: DiscoveryGuardSelf, now?: () => number): string {
  const clock = now ?? Date.now;
  const token: DiscoveryGuardToken = {
    pid: self.pid,
    startedAt: self.startedAt,
    at: clock(),
    nonce: randomUUID(),
  };
  return `${JSON.stringify(token)}\n`;
}

async function readGuardRaw(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function releaseGuardIfTokenMatches(guardPath: string, expectedToken: string): Promise<void> {
  try {
    const current = await readFile(guardPath, "utf8");
    if (current !== expectedToken) return;
    await rm(guardPath, { force: true });
  } catch {
    // best-effort release
  }
}

/** Test helper: read the current guard token raw bytes, if any. */
export async function readDiscoveryGuardRaw(discoveryRoot: string): Promise<string | null> {
  return readGuardRaw(discoveryGuardFile(discoveryRoot));
}

/** Test helper: read the current reclaim lock raw bytes, if any. */
export async function readDiscoveryReclaimRaw(discoveryRoot: string): Promise<string | null> {
  return readGuardRaw(discoveryReclaimLockFile(discoveryRoot));
}

/** Test helper: read the current reclaim2 lock raw bytes, if any. */
export async function readDiscoveryReclaim2Raw(discoveryRoot: string): Promise<string | null> {
  return readGuardRaw(discoveryReclaim2LockFile(discoveryRoot));
}

/** Test helper: whether a guard file exists with empty content. */
export async function isDiscoveryGuardEmpty(discoveryRoot: string): Promise<boolean> {
  const guardPath = discoveryGuardFile(discoveryRoot);
  try {
    const fileStat = await stat(guardPath);
    if (fileStat.size === 0) return true;
    const raw = await readFile(guardPath, "utf8");
    return raw.length === 0;
  } catch {
    return false;
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
