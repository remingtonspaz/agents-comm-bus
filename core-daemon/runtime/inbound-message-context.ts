import type { Message } from "agents-comm-bus-core";
import type { CurlInboundReceiptScope } from "agents-comm-bus-core/storage/storage";

/** Non-enumerable extension key — omitted from JSON serialization of Message payloads. */
const INBOUND_MESSAGE_CONTEXT_KEY = "__agents_comm_bus_inbound_context" as const;

export interface CurlIdempotencyInboundContext {
  kind: "curl_idempotency";
  scope: CurlInboundReceiptScope;
}

export type InboundMessageContext = CurlIdempotencyInboundContext;

export function attachInboundMessageContext(
  message: Message,
  context: InboundMessageContext,
): Message {
  Object.defineProperty(message, INBOUND_MESSAGE_CONTEXT_KEY, {
    value: context,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return message;
}

export function readInboundMessageContext(message: Message): InboundMessageContext | null {
  const descriptor = Object.getOwnPropertyDescriptor(message, INBOUND_MESSAGE_CONTEXT_KEY);
  const ctx = descriptor?.value as InboundMessageContext | undefined;
  if (!ctx || ctx.kind !== "curl_idempotency") return null;
  if (typeof ctx.scope?.registration_id !== "string") return null;
  if (typeof ctx.scope?.sender_id !== "string") return null;
  if (typeof ctx.scope?.client_key !== "string") return null;
  return ctx;
}

export function readCurlIdempotencyScope(message: Message): CurlInboundReceiptScope | null {
  return readInboundMessageContext(message)?.scope ?? null;
}
