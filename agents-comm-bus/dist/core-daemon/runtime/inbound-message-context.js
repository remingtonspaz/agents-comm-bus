/** Non-enumerable extension key — omitted from JSON serialization of Message payloads. */
const INBOUND_MESSAGE_CONTEXT_KEY = "__agents_comm_bus_inbound_context";
export function attachInboundMessageContext(message, context) {
    Object.defineProperty(message, INBOUND_MESSAGE_CONTEXT_KEY, {
        value: context,
        enumerable: false,
        configurable: true,
        writable: true,
    });
    return message;
}
export function readInboundMessageContext(message) {
    const descriptor = Object.getOwnPropertyDescriptor(message, INBOUND_MESSAGE_CONTEXT_KEY);
    const ctx = descriptor?.value;
    if (!ctx || ctx.kind !== "curl_idempotency")
        return null;
    if (typeof ctx.scope?.registration_id !== "string")
        return null;
    if (typeof ctx.scope?.sender_id !== "string")
        return null;
    if (typeof ctx.scope?.client_key !== "string")
        return null;
    return ctx;
}
export function readCurlIdempotencyScope(message) {
    return readInboundMessageContext(message)?.scope ?? null;
}
//# sourceMappingURL=inbound-message-context.js.map