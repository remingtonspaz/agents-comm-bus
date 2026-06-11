import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { SCHEMA_VERSION_ACCOUNT, } from "agents-comm-bus-core";
import { normalizeProjectPath } from "../project-path.js";
import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";
import { probeIdentityViaDaemon } from "./identity-probe.js";
import { writeTokenFile } from "./token-file.js";
export async function accountAdd(options) {
    const project = normalizeProjectPath(options.project);
    const comm = (options.comm ?? "telegram");
    const botToken = options.botToken;
    if (!botToken) {
        throw new Error("--bot-token is required for account-add");
    }
    const identity = await (options.probeIdentity ?? ((token, accountId) => probeIdentityViaDaemon({
        comm,
        botToken: token,
        accountId,
        agent: options.agent,
        stateRoot: options.stateRoot,
    })))(botToken, options.accountId);
    const paths = resolveStatePaths({ stateRoot: options.stateRoot });
    await mkdir(paths.root, { recursive: true });
    const storage = await openSqliteStorage(paths.database);
    try {
        const labelMatches = await storage.listAccountRegistrations({
            project,
            comm,
            agent: options.agent,
        });
        const existingLabel = labelMatches.find((row) => row.account_label === options.accountLabel);
        if (existingLabel) {
            throw new Error(`${comm} account label ${options.accountLabel} is already registered as ` +
                `bot_id=${existingLabel.bot_user_id} for project=${project}, ` +
                `agent=${options.agent}; use account-remove before re-adding, or an ` +
                `account-update command when available.`);
        }
        const existing = await storage.getAccountByBot(comm, identity.bot_user_id);
        if (existing) {
            throw new Error(`${comm} bot id ${identity.bot_user_id} is already registered as ` +
                `project=${existing.project}, agent=${existing.agent}, ` +
                `account_label=${existing.account_label}; use account-list to inspect it ` +
                `or account-remove --comm ${comm} --bot-id ${identity.bot_user_id} before re-adding.`);
        }
        const credentialsRef = await writeTokenFile({
            stateRoot: options.stateRoot,
            comm,
            project,
            agent: options.agent,
            accountId: identity.bot_user_id,
            botToken,
        });
        const now = Date.now();
        const registration = {
            schema_version: SCHEMA_VERSION_ACCOUNT,
            registration_id: `reg_${randomBytes(16).toString("hex")}`,
            project,
            comm,
            agent: options.agent,
            account_label: options.accountLabel,
            bot_user_id: identity.bot_user_id,
            bot_username: identity.bot_username ?? undefined,
            credentials_ref: credentialsRef,
            created_at: now,
            updated_at: now,
            metadata: { source: "account-add" },
        };
        await storage.putAccountRegistration(registration);
        return registration;
    }
    finally {
        await storage.close();
    }
}
//# sourceMappingURL=account-add.js.map