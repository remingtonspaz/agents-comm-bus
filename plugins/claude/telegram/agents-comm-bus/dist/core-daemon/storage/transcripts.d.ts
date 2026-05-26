import type { TranscriptEntry, TranscriptStore } from "agents-comm-bus-core";
import type { ConversationId } from "agents-comm-bus-core";
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