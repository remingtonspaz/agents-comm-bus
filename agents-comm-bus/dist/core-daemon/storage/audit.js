import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { appendJsonLine } from "./jsonl.js";
function utcDay(timestamp) {
    return new Date(timestamp).toISOString().slice(0, 10);
}
export class JsonlAuditStore {
    root;
    constructor(root) {
        this.root = root;
    }
    async append(event) {
        const path = this.pathFor(event.timestamp);
        await mkdir(dirname(path), { recursive: true });
        await appendJsonLine(path, event);
    }
    pathFor(timestamp) {
        return join(this.root, "audit", `${utcDay(timestamp)}.jsonl`);
    }
    async hasInboundReceived(conversation_id, message, auditTimestamp) {
        const path = this.pathFor(auditTimestamp ?? Date.now());
        try {
            const lines = createInterface({
                input: createReadStream(path, { encoding: "utf8" }),
                crlfDelay: Infinity,
            });
            for await (const line of lines) {
                if (line.trim() === "")
                    continue;
                const event = JSON.parse(line);
                if (event.kind === "inbound_received" &&
                    event.conversation_id === conversation_id &&
                    event.detail?.platform_message_id === message.platform_message_id) {
                    return true;
                }
            }
        }
        catch {
            return false;
        }
        return false;
    }
}
//# sourceMappingURL=audit.js.map