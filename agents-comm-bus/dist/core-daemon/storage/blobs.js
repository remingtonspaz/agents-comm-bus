import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
export class ContentAddressedBlobStore {
    root;
    constructor(root) {
        this.root = root;
    }
    async put(content, mime) {
        const hash = createHash("sha256").update(content).digest("hex");
        const ref = { hash, size: content.byteLength, mime };
        const path = this.pathFor(ref);
        await mkdir(join(this.root, "blobs", hash.slice(0, 2)), { recursive: true });
        let handle;
        try {
            handle = await open(path, "wx");
            await handle.writeFile(content);
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
        finally {
            await handle?.close();
        }
        return ref;
    }
    async open(ref) {
        return Readable.toWeb(createReadStream(this.pathFor(ref)));
    }
    pathFor(ref) {
        return join(this.root, "blobs", ref.hash.slice(0, 2), ref.hash);
    }
    async exists(ref) {
        try {
            const info = await stat(this.pathFor(ref));
            return info.isFile() && info.size === ref.size;
        }
        catch {
            return false;
        }
    }
}
//# sourceMappingURL=blobs.js.map