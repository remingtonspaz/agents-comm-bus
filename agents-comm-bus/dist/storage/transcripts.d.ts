import type { TranscriptEntry, TranscriptStore } from "../../packages/core-contracts/dist/storage/transcript-store.js";
import type { ConversationId } from "../../packages/core-contracts/dist/types.js";
export declare class JsonlTranscriptStore implements TranscriptStore {
    private readonly root;
    constructor(root: string);
    append(entry: TranscriptEntry): Promise<void>;
    read(conversation_id: ConversationId, opts?: {
        since?: number;
        limit?: number;
    }): AsyncIterable<TranscriptEntry>;
    pathFor(conversation_id: ConversationId): string;
}
//# sourceMappingURL=transcripts.d.ts.map