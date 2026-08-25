import type { Message } from "agents-comm-bus-core";
import type { CurlInboundReceiptScope } from "agents-comm-bus-core/storage/storage";
export interface CurlIdempotencyInboundContext {
    kind: "curl_idempotency";
    scope: CurlInboundReceiptScope;
}
export type InboundMessageContext = CurlIdempotencyInboundContext;
export declare function attachInboundMessageContext(message: Message, context: InboundMessageContext): Message;
export declare function readInboundMessageContext(message: Message): InboundMessageContext | null;
export declare function readCurlIdempotencyScope(message: Message): CurlInboundReceiptScope | null;
//# sourceMappingURL=inbound-message-context.d.ts.map