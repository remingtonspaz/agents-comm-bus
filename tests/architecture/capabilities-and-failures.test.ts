import { describe, it, expect } from "vitest";
import {
  assertCapability,
  type AgentCapabilities,
  type CommCapabilities,
} from "../../agents-core/src/capabilities.js";
import {
  TransientFailure,
  PermanentFailure,
  isTransient,
  isPermanent,
} from "../../agents-core/src/errors.js";

describe("assertCapability", () => {
  const agentCap: AgentCapabilities = {
    canWake: true,
    canSteer: false,
    canInterrupt: true,
    midTurnPolicy: "queue",
    permissionKinds: ["tool"],
  };

  const commCap: CommCapabilities = {
    canSendText: true,
    canSendAttachments: false,
    supportsThreads: true,
    supportsBots: true,
    bidirectionalBotMessaging: false,
    supportsReplyToMessage: true,
  };

  it("no-ops when capability is enabled (boolean true)", () => {
    expect(() => assertCapability(agentCap, "canWake")).not.toThrow();
    expect(() => assertCapability(commCap, "canSendText")).not.toThrow();
  });

  it("throws when capability is disabled (boolean false)", () => {
    expect(() => assertCapability(agentCap, "canSteer")).toThrow(
      /Capability not supported: canSteer/,
    );
    expect(() => assertCapability(commCap, "canSendAttachments")).toThrow(
      /Capability not supported: canSendAttachments/,
    );
  });

  it("throws Error instances (not custom error subclasses)", () => {
    try {
      assertCapability(commCap, "bidirectionalBotMessaging");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});

describe("failure discrimination", () => {
  it("isTransient identifies TransientFailure", () => {
    const err = new TransientFailure("boom");
    expect(isTransient(err)).toBe(true);
    expect(isPermanent(err)).toBe(false);
  });

  it("isPermanent identifies PermanentFailure", () => {
    const err = new PermanentFailure("boom");
    expect(isPermanent(err)).toBe(true);
    expect(isTransient(err)).toBe(false);
  });

  it("isTransient recognizes subclasses of TransientFailure", () => {
    class NetworkBlip extends TransientFailure {}
    const err = new NetworkBlip("net");
    expect(isTransient(err)).toBe(true);
    expect(isPermanent(err)).toBe(false);
  });

  it("isPermanent recognizes subclasses of PermanentFailure", () => {
    class BadAuth extends PermanentFailure {}
    const err = new BadAuth("auth");
    expect(isPermanent(err)).toBe(true);
    expect(isTransient(err)).toBe(false);
  });

  it("generic Error is neither transient nor permanent", () => {
    const err = new Error("plain");
    expect(isTransient(err)).toBe(false);
    expect(isPermanent(err)).toBe(false);
  });

  it("non-Error values are neither transient nor permanent", () => {
    for (const v of [undefined, null, "string", 42, {}, []]) {
      expect(isTransient(v)).toBe(false);
      expect(isPermanent(v)).toBe(false);
    }
  });

  it("failure-class symmetry: an error is exactly one of T/P/neither", () => {
    const cases: unknown[] = [
      new TransientFailure("a"),
      new PermanentFailure("b"),
      new Error("c"),
      "not-an-error",
    ];
    for (const c of cases) {
      const t = isTransient(c);
      const p = isPermanent(c);
      // never both
      expect(t && p).toBe(false);
    }
  });

  it("carries cause and code metadata", () => {
    const cause = new Error("root");
    const t = new TransientFailure("msg", { cause, code: "E_RETRY" });
    expect(t.cause).toBe(cause);
    expect(t.code).toBe("E_RETRY");
    expect(t.name).toBe("TransientFailure");
    expect(t.message).toBe("msg");

    const p = new PermanentFailure("msg2", { cause, code: "E_BAD" });
    expect(p.cause).toBe(cause);
    expect(p.code).toBe("E_BAD");
    expect(p.name).toBe("PermanentFailure");
  });
});
