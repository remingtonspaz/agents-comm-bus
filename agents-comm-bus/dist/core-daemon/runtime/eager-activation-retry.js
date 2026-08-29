import { ensureRegistrationById } from "./ensure-registration.js";
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const MAX_RETRY_ATTEMPTS = 5;
export function createEagerActivationRetryScheduler(input) {
    const setTimeoutFn = input.setTimeoutFn ?? setTimeout;
    const clearTimeoutFn = input.clearTimeoutFn ?? clearTimeout;
    const timers = new Map();
    const attempts = new Map();
    let stopped = false;
    const clearTimer = (registration_id) => {
        const timer = timers.get(registration_id);
        if (timer !== undefined)
            clearTimeoutFn(timer);
        timers.delete(registration_id);
    };
    const cancel = (registration_id) => {
        clearTimer(registration_id);
        attempts.delete(registration_id);
    };
    const stopAll = () => {
        stopped = true;
        for (const timer of timers.values()) {
            clearTimeoutFn(timer);
        }
        timers.clear();
        attempts.clear();
    };
    const schedule = (registration_id) => {
        if (stopped)
            return;
        const prior = attempts.get(registration_id) ?? 0;
        if (prior >= MAX_RETRY_ATTEMPTS)
            return;
        const attempt = prior + 1;
        attempts.set(registration_id, attempt);
        const delayMs = Math.min(INITIAL_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS);
        clearTimer(registration_id);
        const timer = setTimeoutFn(() => {
            timers.delete(registration_id);
            void (async () => {
                if (stopped)
                    return;
                const row = await input.storage.getAccountByRegistrationId(registration_id);
                if (!row || row.activation !== "eager") {
                    cancel(registration_id);
                    return;
                }
                const outcome = await ensureRegistrationById(registration_id, {
                    ...input.ensure,
                    scheduleEagerRetry: undefined,
                });
                if (stopped)
                    return;
                if (!outcome || outcome.retryClass !== "transient") {
                    cancel(registration_id);
                    return;
                }
                schedule(registration_id);
            })().catch((error) => {
                console.error(`agents-comm-bus: eager retry failed for ${registration_id}: ` +
                    `${error instanceof Error ? error.message : String(error)}`);
            });
        }, delayMs);
        if (timer && typeof timer === "object" && "unref" in timer) {
            timer.unref?.();
        }
        timers.set(registration_id, timer);
    };
    return { schedule, cancel, stopAll };
}
//# sourceMappingURL=eager-activation-retry.js.map