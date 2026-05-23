import type { BlobRef, BlobStore } from "../../../packages/core-contracts/dist/storage/blob-store.js";
export declare class ContentAddressedBlobStore implements BlobStore {
    private readonly root;
    constructor(root: string);
    put(content: Uint8Array, mime?: string): Promise<BlobRef>;
    open(ref: BlobRef): Promise<ReadableStream<Uint8Array>>;
    pathFor(ref: BlobRef): string;
    exists(ref: BlobRef): Promise<boolean>;
}
//# sourceMappingURL=blobs.d.ts.map