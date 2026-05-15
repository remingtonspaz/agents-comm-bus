import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

import type {
  TranscriptEntry,
  TranscriptStore,
} from "../../../agents-comm-bus-core/dist/storage/transcript-store.js";
import type { ConversationId } from "../../../agents-comm-bus-core/dist/types.js";

import { appendJsonLine } from "./jsonl.js";

function safeSegment(value: string): string {
  return encodeURIComponent(value);
}

export class JsonlTranscriptStore implements TranscriptStore {
  constructor(private readonly root: string) {}

  async append(entry: TranscriptEntry): Promise<void> {
    const path = this.pathFor(entry.conversation_id);
    await mkdir(dirname(path), { recursive: true });
    await appendJsonLine(path, entry);
  }

  async *read(
    conversation_id: ConversationId,
    opts: { since?: number; limit?: number } = {},
  ): AsyncIterable<TranscriptEntry> {
    const path = this.pathFor(conversation_id);
    try {
      await stat(path);
    } catch {
      return;
    }

    let yielded = 0;
    const lines = createInterface({
      input: createReadStream(path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (line.trim() === "") continue;
      const entry = JSON.parse(line) as TranscriptEntry;
      if (opts.since !== undefined && entry.timestamp < opts.since) continue;
      yield entry;
      yielded += 1;
      if (opts.limit !== undefined && yielded >= opts.limit) break;
    }
  }

  pathFor(conversation_id: ConversationId): string {
    return join(this.root, "chats", safeSegment(conversation_id), "transcript.jsonl");
  }
}
