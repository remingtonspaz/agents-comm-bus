import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
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
}
//# sourceMappingURL=audit.js.map