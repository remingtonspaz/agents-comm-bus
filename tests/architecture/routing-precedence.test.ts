import { describe, it, expect } from "vitest";
import {
  resolveRoute,
  type Binding,
  type LastActiveAnchor,
} from "../../agents-core/src/routing.js";
import {
  SCHEMA_VERSION_MESSAGE,
  type ChatRef,
  type Message,
} from "../../agents-core/src/types.js";

const chat: ChatRef = {
  comm: "telegram",
  account: "bot-A",
  id: "chat-1",
  thread_id: "thread-x",
};

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    schema_version: SCHEMA_VERSION_MESSAGE,
    message_id: "m1",
    chat,
    sender: { id: "user-42", isBot: false, isForeignBot: false },
    origin: {},
    hop_count: 0,
    received_at: 1000,
    ...overrides,
  };
}

const TARGET_A = { agent: "agentA", session: "sessA" };
const TARGET_B = { agent: "agentB", session: "sessB" };
const TARGET_C = { agent: "agentC", session: "sessC" };

describe("resolveRoute precedence", () => {
  it("exact-match binding wins over partial-match", () => {
    const bindings: Binding[] = [
      {
        comm: "telegram",
        target: TARGET_A,
        created_at: 1,
      },
      {
        comm: "telegram",
        account: "bot-A",
        chat: "chat-1",
        thread: "thread-x",
        sender: "user-42",
        target: TARGET_B,
        created_at: 2,
      },
    ];
    const got = resolveRoute(makeMessage(), bindings, new Map());
    expect(got).toEqual(TARGET_B);
  });

  it("explicit binding always beats last-active anchor", () => {
    const bindings: Binding[] = [
      { comm: "telegram", target: TARGET_A, created_at: 1 },
    ];
    const lastActive: LastActiveAnchor = new Map([
      [`${TARGET_C.agent}:${TARGET_C.session}`, chat],
    ]);
    const got = resolveRoute(makeMessage(), bindings, lastActive);
    expect(got).toEqual(TARGET_A);
  });

  it("creation-order tie-break for same-specificity bindings", () => {
    const bindings: Binding[] = [
      {
        comm: "telegram",
        account: "bot-A",
        target: TARGET_B,
        created_at: 50,
      },
      {
        comm: "telegram",
        account: "bot-A",
        target: TARGET_A,
        created_at: 10,
      },
    ];
    const got = resolveRoute(makeMessage(), bindings, new Map());
    expect(got).toEqual(TARGET_A);
  });

  it("falls back to last-active anchor when no bindings match", () => {
    const bindings: Binding[] = [
      { comm: "slack", target: TARGET_A, created_at: 1 },
    ];
    const lastActive: LastActiveAnchor = new Map([
      [`${TARGET_C.agent}:${TARGET_C.session}`, chat],
    ]);
    const got = resolveRoute(makeMessage(), bindings, lastActive);
    expect(got).toEqual(TARGET_C);
  });

  it("returns null when nothing resolves", () => {
    const bindings: Binding[] = [
      { comm: "slack", target: TARGET_A, created_at: 1 },
    ];
    const lastActive: LastActiveAnchor = new Map([
      [
        `${TARGET_C.agent}:${TARGET_C.session}`,
        { comm: "slack", account: "x", id: "y" },
      ],
    ]);
    const got = resolveRoute(makeMessage(), bindings, lastActive);
    expect(got).toBeNull();
  });
});
