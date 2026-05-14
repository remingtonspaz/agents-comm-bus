import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION_PERMISSION,
  type ChatRef,
  type PermissionRequest,
  type Sender,
} from "../../agents-core/src/types.js";
import {
  validateReply,
  type ReplyEvent,
} from "../../agents-core/src/permissions.js";

const AUTHORIZED_SENDER = "user-1";
const OTHER_SENDER = "user-2";

const sourceChat: ChatRef = {
  comm: "telegram",
  account: "acct-A",
  id: "chat-100",
};

const otherChat: ChatRef = {
  comm: "telegram",
  account: "acct-A",
  id: "chat-999",
};

function makeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    schema_version: SCHEMA_VERSION_PERMISSION,
    request_id: "req-1",
    agent: "agent-1",
    session: "session-1",
    kind: "tool",
    source_chat: sourceChat,
    source_message_id: "msg-source-1",
    prompt_text: "May I?",
    created_at: 1_000_000,
    ttl_ms: 60_000,
    ...overrides,
  };
}

function makeSender(id: string = AUTHORIZED_SENDER): Sender {
  return {
    id,
    display_name: "Tester",
    isBot: false,
    isForeignBot: false,
  };
}

function makeReply(overrides: Partial<ReplyEvent> = {}): ReplyEvent {
  return {
    sender: makeSender(),
    chat: sourceChat,
    received_at: 1_000_500,
    ...overrides,
  };
}

describe("validateReply", () => {
  it("rejects when already resolved", () => {
    const result = validateReply(makeRequest(), makeReply(), {
      authorizedSenderIds: [AUTHORIZED_SENDER],
      alreadyResolved: true,
    });
    expect(result).toEqual({ ok: false, reason: "already_resolved" });
  });

  it("rejects when reply arrives after TTL", () => {
    const req = makeRequest({ created_at: 0, ttl_ms: 1_000 });
    const reply = makeReply({ received_at: 2_000 });
    const result = validateReply(req, reply, {
      authorizedSenderIds: [AUTHORIZED_SENDER],
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects an unauthorized sender", () => {
    const reply = makeReply({ sender: makeSender(OTHER_SENDER) });
    const result = validateReply(makeRequest(), reply, {
      authorizedSenderIds: [AUTHORIZED_SENDER],
    });
    expect(result).toEqual({ ok: false, reason: "unauthorized_sender" });
  });

  it("rejects a stale reply linked to a different source message", () => {
    const reply = makeReply({ reply_to_message_id: "msg-other" });
    const result = validateReply(makeRequest(), reply, {
      authorizedSenderIds: [AUTHORIZED_SENDER],
    });
    expect(result).toEqual({ ok: false, reason: "stale_link" });
  });

  it("rejects when reply is in the wrong chat with no link", () => {
    const req = makeRequest({ source_message_id: undefined });
    const reply = makeReply({ chat: otherChat });
    const result = validateReply(req, reply, {
      authorizedSenderIds: [AUTHORIZED_SENDER],
    });
    expect(result).toEqual({ ok: false, reason: "wrong_chat" });
  });

  it("accepts when reply links to the source message even from a different chat", () => {
    const reply = makeReply({
      chat: otherChat,
      reply_to_message_id: "msg-source-1",
    });
    const result = validateReply(makeRequest(), reply, {
      authorizedSenderIds: [AUTHORIZED_SENDER],
    });
    expect(result).toEqual({ ok: true });
  });

  it("accepts via same-chat fallback when there is no reply link", () => {
    const req = makeRequest({ source_message_id: undefined });
    const reply = makeReply({ chat: { ...sourceChat } });
    const result = validateReply(req, reply, {
      authorizedSenderIds: [AUTHORIZED_SENDER],
    });
    expect(result).toEqual({ ok: true });
  });
});
