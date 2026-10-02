// AGE-65 / AGE-110: shared inbound wake seed for native watcher and herdr prompt.
export const WAKE_SEED_MAX_CHARS = 2000;
export function sanitizeWakeSeed(text) {
    if (!text)
        return "";
    const normalized = text
        .replace(/\r\n?/g, "\n")
        .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "")
        .trim();
    return normalized.length > WAKE_SEED_MAX_CHARS
        ? normalized.slice(0, WAKE_SEED_MAX_CHARS)
        : normalized;
}
export function buildWakeSeed(input) {
    const body = (input.body ?? "").trim();
    if (!body)
        return "";
    const comm = input.comm && input.comm.length > 0 ? input.comm : "message";
    const sender = input.sender && input.sender.length > 0 ? input.sender : "unknown sender";
    return sanitizeWakeSeed(`${comm} message from ${sender}: ${body}`);
}
//# sourceMappingURL=wake-seed.js.map