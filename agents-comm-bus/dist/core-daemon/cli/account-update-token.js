import { rm } from "node:fs/promises";
import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";
import { resolveAccountByLabel } from "./account-selector.js";
import { probeIdentityViaDaemon } from "./identity-probe.js";
import { writeTokenFile } from "./token-file.js";
export async function accountUpdateToken(options) {
    const comm = (options.comm ?? "telegram");
    if (!options.botToken) {
        throw new Error("--bot-token is required for account-update-token");
    }
    const identity = await (options.probeIdentity ?? ((token, accountId) => probeIdentityViaDaemon({
        comm,
        botToken: token,
        accountId,
        agent: options.agent,
        stateRoot: options.stateRoot,
    })))(options.botToken, options.accountId);
    const storage = await openSqliteStorage(resolveStatePaths({ stateRoot: options.stateRoot }).database);
    let wroteTokenRef = null;
    let wroteReplacementToken = false;
    try {
        const current = await resolveCurrentAccount(storage, {
            comm,
            botId: options.botId,
            accountLabel: options.accountLabel,
            agent: options.agent,
            project: options.project,
        });
        const botChanged = current.bot_user_id !== identity.bot_user_id;
        if (botChanged && !options.allowBotChange) {
            throw new Error(`Token belongs to a different bot (current ${current.bot_user_id} -> ` +
                `${identity.bot_user_id}). This changes the bot identity and will remap ` +
                `allowlist + conversation rows. Re-run with --allow-bot-change if intentional.`);
        }
        if (botChanged) {
            const existing = await storage.getAccountByBot(comm, identity.bot_user_id);
            if (existing) {
                throw new Error(`${comm} bot id ${identity.bot_user_id} is already registered as ` +
                    `project=${existing.project}, agent=${existing.agent}, ` +
                    `account_label=${existing.account_label}; account-update-token cannot ` +
                    `replace ${current.bot_user_id} with an already-registered bot.`);
            }
        }
        const credentialsRef = await writeTokenFile({
            stateRoot: options.stateRoot,
            comm,
            project: current.project,
            agent: current.agent,
            accountId: identity.bot_user_id,
            botToken: options.botToken,
        });
        wroteTokenRef = credentialsRef;
        wroteReplacementToken = botChanged;
        const result = await storage.updateAccountRegistrationToken({
            comm,
            current_bot_user_id: current.bot_user_id,
            new_bot_user_id: identity.bot_user_id,
            credentials_ref: credentialsRef,
            bot_username: identity.bot_username ?? undefined,
            updated_at: Date.now(),
        });
        if (botChanged) {
            await removeOldTokenFile(current.credentials_ref, credentialsRef);
        }
        return result;
    }
    catch (error) {
        if (wroteTokenRef && wroteReplacementToken) {
            await removeTokenFile(wroteTokenRef);
        }
        throw error;
    }
    finally {
        await storage.close();
    }
}
async function resolveCurrentAccount(storage, selector) {
    if (selector.botId) {
        const row = await storage.getAccountByBot(selector.comm, selector.botId);
        if (!row) {
            throw new Error(`no account registration found for (comm=${selector.comm}, bot-id=${selector.botId}); ` +
                "run `agents-comm account-list` to inspect registered accounts");
        }
        return row;
    }
    if (!selector.accountLabel) {
        throw new Error(`account-update-token requires --bot-id or --account-label for ${selector.comm}; ` +
            "run `agents-comm account-list` to inspect registered accounts");
    }
    return resolveAccountByLabel(storage, {
        comm: selector.comm,
        accountLabel: selector.accountLabel,
        agent: selector.agent,
        project: selector.project,
    });
}
async function removeOldTokenFile(oldRef, newRef) {
    const oldPath = filePathFromRef(oldRef);
    const newPath = filePathFromRef(newRef);
    if (!oldPath || oldPath === newPath)
        return;
    await rm(oldPath, { force: true });
}
async function removeTokenFile(ref) {
    const filePath = filePathFromRef(ref);
    if (!filePath)
        return;
    await rm(filePath, { force: true });
}
function filePathFromRef(ref) {
    return ref.startsWith("file:") ? ref.slice("file:".length) : null;
}
//# sourceMappingURL=account-update-token.js.map