import type {
  AccountId,
  AccountRegistration,
  AgentId,
  CommId,
  Storage,
} from "agents-comm-bus-core";

import type { MessageBus } from "../bus.js";
import type { JsonlAuditStore } from "../storage/audit.js";
import type { ContentAddressedBlobStore } from "../storage/blobs.js";
import type { AgentBridge } from "./agent-bridge.js";
import type { EnsureRegistrationResult } from "./agent-bridge.js";
import type { CommAdapterFactory } from "./comm-factory.js";
import type { CommLeaseArbiter, AgentLeaseProperties } from "./comm-lease.js";
import type { SessionOwnerLiveness } from "./session-owner-liveness.js";
import {
  addAdapterForRegistration,
  adapterMapKey,
  appendCredentialResolutionFailedAudit,
  logInvalidCredentialResolution,
  unresolvedCredentialsReason,
} from "./comm-adapter-lifecycle.js";

export type EnsureRegistrationRetryClass = "permanent" | "transient";

export type { EnsureRegistrationResult } from "./agent-bridge.js";

export interface EnsureRegistrationContext {
  factories: CommAdapterFactory[];
  rescanFactories?: (comm: string) => Promise<CommAdapterFactory | undefined>;
  bus: MessageBus;
  bridges: AgentBridge[];
  storage: Storage;
  env: NodeJS.ProcessEnv;
  blobs: ContentAddressedBlobStore;
  stateRoot: string;
  leaseArbiter: CommLeaseArbiter;
  inFlight: Set<string>;
  audit?: JsonlAuditStore;
  agent?: AgentId;
  agentLeaseProperties?: AgentLeaseProperties;
  discoveryRoot?: string;
  sessionOwnerIsLive?: SessionOwnerLiveness;
  /** AGE-97: schedule bounded retries for eager registrations on transient failure. */
  scheduleEagerRetry?: (registration_id: string) => void;
}

function registrationBase(registration: AccountRegistration) {
  return {
    registration_id: registration.registration_id,
    comm: registration.comm,
    account_id: registration.bot_user_id,
  };
}

/**
 * AGE-97: exact-single-registration ensure keyed on `registration_id`. Never
 * touches `activeScopes` or session-scope loops — use for eager activation only.
 */
export async function ensureRegistrationForAccount(
  registration: AccountRegistration,
  input: EnsureRegistrationContext,
): Promise<EnsureRegistrationResult> {
  const base = registrationBase(registration);
  let factory = input.factories.find((candidate) => candidate.commId === registration.comm);
  let rescanned = false;
  if (!factory && input.rescanFactories) {
    factory = await input.rescanFactories(registration.comm);
    rescanned = true;
  }
  if (!factory) {
    const reason = "no_comm_factory";
    console.error(
      `agents-comm-bus: ensureRegistration ${registration.registration_id}: ` +
        `no comm adapter factory for "${registration.comm}" after on-demand re-scan ` +
        `(project=${registration.project}, agent=${registration.agent}, bot=${registration.bot_user_id}) — skipping adapter`,
    );
    await input.audit
      ?.append({
        timestamp: Date.now(),
        kind: "comm_adapter_skip",
        agent: registration.agent,
        detail: {
          comm: registration.comm,
          account_id: registration.bot_user_id,
          account_label: registration.account_label,
          project: registration.project,
          reason,
          rescanned,
          via: "ensure_registration",
          registration_id: registration.registration_id,
        },
      })
      .catch(() => {});
    return {
      status: "no-factory",
      ...base,
      rescanned,
      retryClass: "permanent",
      reason,
    };
  }

  const accountId = registration.bot_user_id as AccountId;
  const key = adapterMapKey(registration.comm, accountId);

  if (input.agentLeaseProperties) {
    input.leaseArbiter.setDesiredAgentProperties(
      registration.comm,
      registration.bot_user_id,
      input.agentLeaseProperties,
    );
  }

  if (input.bus.getComm(registration.comm, accountId)) {
    if (input.agentLeaseProperties) {
      await input.leaseArbiter.syncAgentProperties(registration.comm, registration.bot_user_id);
    }
    return { status: "already-live", ...base, retryClass: "success" };
  }

  if (input.inFlight.has(key)) {
    if (input.agentLeaseProperties) {
      await input.leaseArbiter.syncAgentProperties(registration.comm, registration.bot_user_id);
    }
    return { status: "in-flight", ...base, retryClass: "success" };
  }

  input.inFlight.add(key);
  try {
    const result = await addAdapterForRegistration({
      factory,
      registration,
      bus: input.bus,
      bridges: input.bridges,
      env: input.env,
      blobs: input.blobs,
      stateRoot: input.stateRoot,
      storage: input.storage,
      leaseArbiter: input.leaseArbiter,
      discoveryRoot: input.discoveryRoot,
      sessionOwnerIsLive: input.sessionOwnerIsLive,
    });
    if (result.ok) {
      if (input.agentLeaseProperties) {
        await input.leaseArbiter.syncAgentProperties(registration.comm, registration.bot_user_id);
      }
      return { status: "started", ...base, retryClass: "success" };
    }

    if (result.retryClass === "permanent") {
      if (result.resolution.status === "invalid") {
        logInvalidCredentialResolution(registration, factory.commId, result.resolution);
        await appendCredentialResolutionFailedAudit(
          input.audit,
          registration,
          factory.commId,
          result.resolution,
        );
      } else {
        console.error(
          `agents-comm-bus: ensureRegistration could not start ${key}: ${result.reason}`,
        );
        await input.audit
          ?.append({
            timestamp: Date.now(),
            kind: "comm_adapter_skip",
            agent: registration.agent,
            detail: {
              comm: registration.comm,
              account_id: registration.bot_user_id,
              account_label: registration.account_label,
              project: registration.project,
              reason: result.reason,
              via: "ensure_registration",
              registration_id: registration.registration_id,
            },
          })
          .catch(() => {});
      }
      return {
        status: "invalid-credentials",
        ...base,
        reason: result.reason,
        retryClass: "permanent",
        resolution: result.resolution,
      };
    }

    if (result.resolution) {
      console.error(
        `agents-comm-bus: ensureRegistration could not start ${key}: ${result.reason}`,
      );
      await input.audit
        ?.append({
          timestamp: Date.now(),
          kind: "comm_adapter_skip",
          agent: registration.agent,
          detail: {
            comm: registration.comm,
            account_id: registration.bot_user_id,
            account_label: registration.account_label,
            project: registration.project,
            reason: result.reason,
            via: "ensure_registration",
            registration_id: registration.registration_id,
          },
        })
        .catch(() => {});
      if (registration.activation === "eager" && input.scheduleEagerRetry) {
        input.scheduleEagerRetry(registration.registration_id);
      }
      return {
        status: "start-failed",
        ...base,
        reason: result.reason,
        retryClass: "transient",
        resolution: result.resolution,
      };
    }

    console.error(
      `agents-comm-bus: ensureRegistration construction failed ${key}: ${result.reason}`,
    );
    if (registration.activation === "eager" && input.scheduleEagerRetry) {
      input.scheduleEagerRetry(registration.registration_id);
    }
    return {
      status: "construction-failed",
      ...base,
      reason: result.reason,
      retryClass: "transient",
    };
  } finally {
    input.inFlight.delete(key);
  }
}

export async function ensureRegistrationById(
  registration_id: string,
  input: EnsureRegistrationContext,
): Promise<EnsureRegistrationResult | null> {
  const registration = await input.storage.getAccountByRegistrationId(registration_id);
  if (!registration) return null;
  return ensureRegistrationForAccount(registration, input);
}

export async function reconcileEagerRegistrations(input: {
  storage: Storage;
  ensure: EnsureRegistrationContext;
}): Promise<EnsureRegistrationResult[]> {
  const registrations = await input.storage.listAccountRegistrations();
  const eager = registrations.filter((row) => row.activation === "eager");
  const outcomes: EnsureRegistrationResult[] = [];
  for (const registration of eager) {
    try {
      outcomes.push(await ensureRegistrationForAccount(registration, input.ensure));
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : String(error);
      console.error(
        `agents-comm-bus: eager reconcile failed for ${registration.registration_id}: ${reason}`,
      );
    }
  }
  return outcomes;
}
