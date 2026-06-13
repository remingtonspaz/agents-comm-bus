import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TelegramCommAdapterFactory } from "../../adapters/telegram/factory.js";
import type { SendRequest } from "../../core-daemon/bus.js";
import type {
  AccountRegistration,
  AgentId,
  CommId,
  MessageId,
  Session,
  SessionId,
  Storage,
} from "../../packages/core-contracts/src/index.js";
import { SCHEMA_VERSION_ACCOUNT } from "../../packages/core-contracts/src/index.js";

const TELEGRAM = "telegram" as CommId;
const CODEX = "codex" as AgentId;

describe("Telegram IPC send target routing", () => {
  it("preserves an explicit target account instead of inferring from the caller session", async () => {
    const storage = new TargetStorage([
      registration({
        project: "D:\\Documents\\claude-code-telegram-universal-overhaul",
        account_label: "main",
        bot_user_id: "8988792099",
      }),
      registration({
        project: "D:\\Documents\\web\\stonks",
        account_label: "stonks codex dev",
        bot_user_id: "8743694023",
      }),
    ], {
      session_id: "codex_universal" as SessionId,
      agent: CODEX,
      project: "D:\\Documents\\claude-code-telegram-universal-overhaul",
      schema_version: 1,
      created_at: 1,
      lease_holder_connection_id: null,
      lease_acquired_at: null,
      lease_released_at: null,
      lease_owner_process_pid: null,
      lease_owner_process_label: null,
      lease_owner_process_registered_at: null,
lease_owner_daemon_discovery_root: null,
lease_owner_daemon_checkout_root: null,
lease_owner_daemon_state_root: null,
lease_owner_daemon_bin: null,
lease_owner_daemon_authority_rank: null,
      most_recent_inbound_conversation_id: null,
      status: "active",
    });
    const bus = new RecordingBus();
    const factory = new TelegramCommAdapterFactory();
    const handler = factory.ipcMethods({
      bus: bus as never,
      storage: storage as never,
      pendingInbound: [],
    } as never).get("telegram_send");

    assert.ok(handler);
    await handler({
      session: "codex_universal",
      message: "probe",
      target: {
        account: "8743694023",
        chat_native_id: "8296218244",
      },
    });

    assert.equal(bus.lastSend?.target?.account, "8743694023");
    assert.equal(bus.lastSend?.target?.chat_native_id, "8296218244");
  });
});

function registration(overrides: Partial<AccountRegistration>): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project: "D:\\Documents\\web\\stonks",
    comm: TELEGRAM,
    agent: CODEX,
    account_label: "main",
    bot_user_id: "8743694023",
    credentials_ref: "env:TELEGRAM_BOT_TOKEN",
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

class RecordingBus {
  lastSend: SendRequest | null = null;

  async send(request: SendRequest): Promise<MessageId> {
    this.lastSend = request;
    return "telegram:1" as MessageId;
  }
}

class TargetStorage implements Partial<Storage> {
  constructor(
    private readonly registrations: AccountRegistration[],
    private readonly session: Session,
  ) {}

  async getSession(session: SessionId): Promise<Session | null> {
    return session === this.session.session_id ? this.session : null;
  }

  async listAccountRegistrations(filter?: {
    project?: string;
    comm?: CommId;
    agent?: AgentId;
  }): Promise<AccountRegistration[]> {
    return this.registrations.filter((registration) => {
      if (filter?.project !== undefined && registration.project !== filter.project) return false;
      if (filter?.comm !== undefined && registration.comm !== filter.comm) return false;
      if (filter?.agent !== undefined && registration.agent !== filter.agent) return false;
      return true;
    });
  }
}
