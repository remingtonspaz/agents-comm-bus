import { open } from "node:fs/promises";
export async function appendJsonLine(path, value) {
    const handle = await open(path, "a");
    try {
        await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
//# sourceMappingURL=jsonl.js.map