import type { Storage } from "agents-comm-bus-core";

import type { EnsureRegistrationContext } from "./ensure-registration.js";
import { ensureRegistrationById } from "./ensure-registration.js";

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const MAX_RETRY_ATTEMPTS = 5;

export interface EagerActivationRetryScheduler {
  schedule(registration_id: string): void;
  cancel(registration_id: string): void;
  stopAll(): void;
}

export function createEagerActivationRetryScheduler(input: {
  storage: Storage;
  ensure: EnsureRegistrationContext;
}): EagerActivationRetryScheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const attempts = new Map<string, number>();

  const stopAll = (): void => {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    attempts.clear();
  };

  const cancel = (registration_id: string): void => {
    const timer = timers.get(registration_id);
    if (timer) clearTimeout(timer);
    timers.delete(registration_id);
    attempts.delete(registration_id);
  };

  const schedule = (registration_id: string): void => {
    const prior = attempts.get(registration_id) ?? 0;
    if (prior >= MAX_RETRY_ATTEMPTS) return;
    const attempt = prior + 1;
    attempts.set(registration_id, attempt);
    const delayMs = Math.min(INITIAL_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS);
    cancel(registration_id);
    const timer = setTimeout(() => {
      timers.delete(registration_id);
      void (async () => {
        const row = await input.storage.getAccountByRegistrationId(registration_id);
        if (!row || row.activation !== "eager") {
          cancel(registration_id);
          return;
        }
        const outcome = await ensureRegistrationById(registration_id, input.ensure);
        if (outcome && outcome.retryClass === "transient") {
          schedule(registration_id);
        }
      })().catch((error) => {
        console.error(
          `agents-comm-bus: eager retry failed for ${registration_id}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, delayMs);
    timer.unref?.();
    timers.set(registration_id, timer);
  };

  return { schedule, cancel, stopAll };
}
