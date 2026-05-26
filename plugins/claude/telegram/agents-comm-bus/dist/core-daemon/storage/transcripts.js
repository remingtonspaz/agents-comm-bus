import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { appendJsonLine } from "./jsonl.js";
function safeSegment(value) {
    return encodeURIComponent(value);
}
export class JsonlTranscriptStore {
    root;
    constructor(root) {
        this.root = root;
    }
    async append(entry) {
        const path = this.pathFor(entry.conversation_id);
        await mkdir(dirname(path), { recursive: true });
        await appendJsonLine(path, entry);
    }
    async *read(conversation_id, opts = {}) {
        const path = this.pathFor(conversation_id);
        try {
            await stat(path);
        }
        catch {
            return;
        }
        let yielded = 0;
        const lines = createInterface({
            input: createReadStream(path, { encoding: "utf8" }),
            crlfDelay: Infinity,
        });
        for await (const line of lines) {
            if (line.trim() === "")
                continue;
            const entry = JSON.parse(line);
            if (opts.since !== undefined && entry.timestamp < opts.since)
                continue;
            yield entry;
            yielded += 1;
            if (opts.limit !== undefined && yielded >= opts.limit)
                break;
        }
    }
    pathFor(conversation_id) {
        return join(this.root, "chats", safeSegment(conversation_id), "transcript.jsonl");
    }
}
//# sourceMappingURL=transcripts.js.map