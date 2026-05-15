import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isCrossAgentAllowed,
  type SubscriptionRule,
} from "../../agents-comm-bus-core/src/security.js";
import type { AgentId } from "../../agents-comm-bus-core/src/types.js";

const CLAUDE = "claude" as AgentId;
const CODEX = "codex" as AgentId;
const REVIEWER = "reviewer" as AgentId;

describe("bus invariants", () => {
  describe("no implicit cross-agent delivery", () => {
    it("allows same-agent delivery without a subscription", () => {
      assert.equal(isCrossAgentAllowed(CLAUDE, CLAUDE, []), true);
    });

    it("denies cross-agent delivery by default", () => {
      assert.equal(isCrossAgentAllowed(CLAUDE, CODEX, []), false);
    });

    it("allows only explicitly subscribed cross-agent delivery", () => {
      const subscriptions: SubscriptionRule[] = [
        { fromAgent: CLAUDE, toAgent: CODEX },
      ];

      assert.equal(isCrossAgentAllowed(CLAUDE, CODEX, subscriptions), true);
      assert.equal(isCrossAgentAllowed(CODEX, CLAUDE, subscriptions), false);
      assert.equal(isCrossAgentAllowed(CLAUDE, REVIEWER, subscriptions), false);
    });
  });
});
