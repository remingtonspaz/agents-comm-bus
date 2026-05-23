import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  AuditEvent,
  AuditStore,
} from "../../../packages/core-contracts/dist/storage/audit-store.js";

import { appendJsonLine } from "./jsonl.js";

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export class JsonlAuditStore implements AuditStore {
  constructor(private readonly root: string) {}

  async append(event: AuditEvent): Promise<void> {
    const path = this.pathFor(event.timestamp);
    await mkdir(dirname(path), { recursive: true });
    await appendJsonLine(path, event);
  }

  pathFor(timestamp: number): string {
    return join(this.root, "audit", `${utcDay(timestamp)}.jsonl`);
  }
}
