import type { QueryKind } from "./queries.js";

/**
 * How an agent handles inbound messages that arrive while a turn is in flight.
 *
 * - `queue`: buffer the message and deliver on next turn boundary.
 * - `steer`: inject the message into the running turn as additional guidance.
 * - `interrupt`: cancel the in-flight turn and start a new one with the message.
 * - `reject`: refuse the message (caller must retry later).
 */
export type MidTurnPolicy = "queue" | "steer" | "interrupt" | "reject";

export interface AgentCapabilities {
  /** Adapter can wake a session that is otherwise idle (turn-start). */
  canWake: boolean;
  /** Adapter can inject mid-turn guidance without canceling the turn. */
  canSteer: boolean;
  /** Adapter can cancel an in-flight turn. */
  canInterrupt: boolean;
  /** Behavior when an inbound message arrives during an in-flight turn. */
  midTurnPolicy: MidTurnPolicy;
  /** Query kinds this adapter is willing to surface to its agent. */
  supportedQueryKinds: readonly QueryKind[];
}
