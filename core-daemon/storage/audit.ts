import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

import type {
  AuditEvent,
  AuditStore,
  ConversationId,
  Message,
} from "agents-comm-bus-core";

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

  async hasInboundReceived(
    conversation_id: ConversationId,
    message: Pick<Message, "platform_message_id">,
    auditTimestamp?: number,
  ): Promise<boolean> {
    const path = this.pathFor(auditTimestamp ?? Date.now());
    try {
      const lines = createInterface({
        input: createReadStream(path, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (line.trim() === "") continue;
        const event = JSON.parse(line) as AuditEvent;
        if (
          event.kind === "inbound_received" &&
          event.conversation_id === conversation_id &&
          event.detail?.platform_message_id === message.platform_message_id
        ) {
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }
}
