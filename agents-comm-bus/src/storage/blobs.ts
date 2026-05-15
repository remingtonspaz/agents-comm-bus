import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import type {
  BlobRef,
  BlobStore,
} from "../../../agents-comm-bus-core/dist/storage/blob-store.js";

export class ContentAddressedBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  async put(content: Uint8Array, mime?: string): Promise<BlobRef> {
    const hash = createHash("sha256").update(content).digest("hex");
    const ref: BlobRef = { hash, size: content.byteLength, mime };
    const path = this.pathFor(ref);
    await mkdir(join(this.root, "blobs", hash.slice(0, 2)), { recursive: true });

    let handle;
    try {
      handle = await open(path, "wx");
      await handle.writeFile(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await handle?.close();
    }

    return ref;
  }

  async open(ref: BlobRef): Promise<ReadableStream<Uint8Array>> {
    return Readable.toWeb(createReadStream(this.pathFor(ref))) as ReadableStream<Uint8Array>;
  }

  pathFor(ref: BlobRef): string {
    return join(this.root, "blobs", ref.hash.slice(0, 2), ref.hash);
  }

  async exists(ref: BlobRef): Promise<boolean> {
    try {
      const info = await stat(this.pathFor(ref));
      return info.isFile() && info.size === ref.size;
    } catch {
      return false;
    }
  }
}
