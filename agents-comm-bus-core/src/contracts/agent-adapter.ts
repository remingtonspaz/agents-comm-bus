import type { AgentCapabilities } from "../capabilities.js";
import type { Message } from "../messages.js";
import type { Query, ResolvedDecision } from "../queries.js";
import type { AgentId, SessionId } from "../types.js";

/**
 * Long-lived bidirectional channel between the bus and an agent adapter for a
 * given session. The lifetime of this channel **is** the session lease (v4
 * non-negotiable #6): when the channel closes, the bus must treat the session
 * as released and clean up any open queries.
 */
export interface ControlChannel {
  /** Register a handler invoked when the channel closes for any reason. */
  onClose(handler: () => void): void;
  /** Send an envelope to the peer. Resolves when the message is flushed. */
  send(envelope: unknown): Promise<void>;
}

/**
 * Per-query blocking channel. Its lifetime is the query lease: closing the
 * channel before the query is resolved fails the query closed.
 */
export interface QueryChannel extends ControlChannel {
  /** Resolves with the decision when the query is answered. */
  awaitResolution(): Promise<ResolvedDecision>;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly capabilities: AgentCapabilities;

  /**
   * Open the long-lived control connection for `session`. The lifetime of the
   * returned promise's underlying channel is the session lease — closing it
   * releases the session.
   */
  connect(session: SessionId, controlChannel: ControlChannel): Promise<void>;

  /** Tear down the session lease. */
  disconnect(session: SessionId): Promise<void>;

  /** Deliver an inbound message to the agent for the given session. */
  deliverInbound(session: SessionId, message: Message): Promise<void>;

  /**
   * Open a per-query blocking connection. Closing `queryChannel` before
   * resolution must be treated as a failed-closed query.
   */
  openQuery(
    session: SessionId,
    query: Query,
    queryChannel: QueryChannel,
  ): Promise<void>;

  /** Optional turn-start. No-op for adapters with `canWake: false`. */
  wake(session: SessionId): Promise<void>;

  /** Inject mid-turn guidance. Only valid when `capabilities.canSteer` is true. */
  steer(session: SessionId, payload: unknown): Promise<void>;

  /** Cancel an in-flight turn. Only valid when `capabilities.canInterrupt` is true. */
  interrupt(session: SessionId): Promise<void>;
}
