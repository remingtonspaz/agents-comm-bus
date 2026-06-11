#!/usr/bin/env node
import { accountAdd } from "./account-add.js";
import { accountList } from "./account-list.js";
import { accountRelabel, } from "./account-relabel.js";
import { accountRemove } from "./account-remove.js";
import { accountUpdateToken, } from "./account-update-token.js";
import { allowlistAdd } from "./allowlist-add.js";
import { allowlistImportFromEnv, allowlistImportFromFiles, } from "./allowlist-import.js";
import { allowlistList } from "./allowlist-list.js";
import { allowlistRemove } from "./allowlist-remove.js";
import { parseMigrateArgs, runMigration } from "./migrate.js";
import { reloadDaemonRegistrations } from "./reload-helper.js";
import { daemonStatus, formatDaemonStatus } from "./status.js";
async function main() {
    const [command, ...rest] = process.argv.slice(2);
    const args = parseArgs(rest);
    switch (command) {
        case "account-add": {
            const rec = await accountAdd({
                project: required(args.project, "--project"),
                agent: required(args.agent, "--agent"),
                accountLabel: required(args.accountLabel ?? args["account-label"], "--account-label"),
                comm: args.comm,
                botToken: args.botToken ?? args["bot-token"],
                accountId: args.accountId ?? args["account-id"],
            });
            const reload = await reloadDaemonRegistrations();
            console.log(JSON.stringify({ ...redact(rec), reload }, null, 2));
            return;
        }
        case "account-list": {
            const rows = await accountList({
                project: args.project,
                agent: args.agent,
                comm: args.comm,
            });
            console.log(JSON.stringify(rows.map(redact), null, 2));
            return;
        }
        case "account-remove": {
            await accountRemove({
                project: args.project,
                agent: args.agent,
                comm: args.comm,
                accountLabel: args.accountLabel ?? args["account-label"],
                botId: args.botId ?? args["bot-id"],
            });
            const reload = await reloadDaemonRegistrations();
            console.log(JSON.stringify({ ok: true, reload }, null, 2));
            return;
        }
        case "account-relabel": {
            const result = await accountRelabel({
                project: args.project,
                agent: args.agent,
                comm: args.comm,
                accountLabel: args.accountLabel ?? args["account-label"],
                botId: args.botId ?? args["bot-id"],
                newAccountLabel: required(args.newAccountLabel ?? args["new-account-label"], "--new-account-label"),
            });
            const reload = await reloadDaemonRegistrations();
            console.log(JSON.stringify({ ...redact(result.next), relabel: relabelSummary(result), reload }, null, 2));
            return;
        }
        case "account-update-token": {
            const result = await accountUpdateToken({
                comm: args.comm,
                botId: args.botId ?? args["bot-id"],
                accountLabel: args.accountLabel ?? args["account-label"],
                agent: args.agent,
                project: args.project,
                botToken: required(args.botToken ?? args["bot-token"], "--bot-token"),
                accountId: args.accountId ?? args["account-id"],
                allowBotChange: args.allowBotChange !== undefined || args["allow-bot-change"] !== undefined,
            });
            const reload = await reloadDaemonRegistrations({
                forceCredentialRefresh: result.bot_changed
                    ? []
                    : [{ comm: result.next.comm, accountId: result.next.bot_user_id }],
            });
            console.log(JSON.stringify({ ...redact(result.next), update: resultSummary(result), reload }, null, 2));
            return;
        }
        case "allowlist": {
            await handleAllowlist(rest);
            return;
        }
        case "migrate": {
            const result = runMigration(parseMigrateArgs(rest));
            console.log(JSON.stringify(result, null, 2));
            return;
        }
        case "status": {
            const snapshot = await daemonStatus({
                stateRoot: args.stateRoot ?? args["state-root"],
                discoveryRoot: args.discoveryRoot ?? args["discovery-root"],
            });
            if (args.json !== undefined || args["json"] !== undefined) {
                console.log(JSON.stringify(snapshot, null, 2));
            }
            else {
                console.log(formatDaemonStatus(snapshot));
            }
            return;
        }
        default:
            printHelp();
            process.exit(command ? 1 : 0);
    }
}
async function handleAllowlist(rest) {
    const [sub, ...subRest] = rest;
    const args = parseArgs(subRest);
    switch (sub) {
        case "add": {
            const scope = allowlistScopeFromArgs(args);
            const out = await allowlistAdd({
                comm: required(args.comm, "--comm"),
                user: required(args.user, "--user"),
                note: args.note,
                scope,
                botId: args.botId ?? args["bot-id"],
                agent: args.agent,
                project: args.project,
                accountLabel: args.accountLabel ?? args["account-label"],
            });
            const reload = await reloadDaemonRegistrations();
            console.log(JSON.stringify({ ...out, reload }, null, 2));
            return;
        }
        case "remove": {
            const scope = allowlistScopeFromArgs(args);
            const out = await allowlistRemove({
                comm: required(args.comm, "--comm"),
                user: required(args.user, "--user"),
                scope,
                botId: args.botId ?? args["bot-id"],
                agent: args.agent,
                project: args.project,
                accountLabel: args.accountLabel ?? args["account-label"],
            });
            const reload = await reloadDaemonRegistrations();
            console.log(JSON.stringify({ ...out, reload }, null, 2));
            return;
        }
        case "list": {
            const scopeArg = args.scope;
            if (scopeArg && scopeArg !== "global" && scopeArg !== "per-bot" && scopeArg !== "all") {
                throw new Error("--scope must be one of: global | per-bot | all");
            }
            const out = await allowlistList({
                comm: args.comm,
                scope: scopeArg,
                botId: args.botId ?? args["bot-id"],
                agent: args.agent,
                project: args.project,
                accountLabel: args.accountLabel ?? args["account-label"],
            });
            console.log(JSON.stringify(out, null, 2));
            return;
        }
        case "import-from-env": {
            const out = await allowlistImportFromEnv({ comm: args.comm });
            const reload = await reloadDaemonRegistrations();
            console.log(JSON.stringify({ ...out, reload }, null, 2));
            return;
        }
        case "import-from-files": {
            const dryRun = args.dryRun !== undefined || args["dry-run"] !== undefined;
            const out = await allowlistImportFromFiles({ comm: args.comm, dryRun });
            const reload = dryRun ? { attempted: false, reason: "dry-run" } : await reloadDaemonRegistrations();
            console.log(JSON.stringify({ ...out, reload }, null, 2));
            return;
        }
        default:
            printHelp();
            throw new Error(`unknown allowlist subcommand: ${sub ?? "(none)"}`);
    }
}
function allowlistScopeFromArgs(args) {
    const hasPerBotSelector = Boolean(args.botId ?? args["bot-id"] ?? args.agent ?? args.project ?? args.accountLabel ?? args["account-label"]);
    return hasPerBotSelector ? "per-bot" : "global";
}
function parseArgs(args) {
    const parsed = {};
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (!arg.startsWith("--"))
            continue;
        const key = arg.slice(2);
        const value = args[i + 1]?.startsWith("--") ? undefined : args[++i];
        parsed[key] = value;
        parsed[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
    return parsed;
}
function required(value, label) {
    if (!value)
        throw new Error(`${label} is required`);
    return value;
}
function redact(row) {
    return { ...row, credentials_ref: row.credentials_ref ? "[redacted]" : row.credentials_ref };
}
function printHelp() {
    console.error(`agents-comm-bus CLI

Account commands:
  agents-comm-bus account-add --project <path> --agent <agent> --account-label <label> --bot-token <token> [--comm <comm>] [--account-id <id>]
  agents-comm-bus account-list [--project <path>] [--agent <agent>] [--comm telegram]
  agents-comm-bus account-remove [--comm telegram] (--bot-id <id> | --account-label <label> [--agent <agent>] [--project <path>])
  agents-comm-bus account-relabel [--comm telegram] (--bot-id <id> | --account-label <label> [--agent <agent>] [--project <path>]) --new-account-label <label>
  agents-comm-bus account-update-token [--comm telegram] (--bot-id <id> | --account-label <label> [--agent <agent>] [--project <path>]) --bot-token <token> [--account-id <id>] [--allow-bot-change]

Allowlist commands:
  agents-comm-bus allowlist add    --comm <c> --user <id> [--note "..."]                                                      # global
  agents-comm-bus allowlist add    --comm <c> --user <id> (--bot-id <id> | --account-label <label> [--agent <a>] [--project <p>])
  agents-comm-bus allowlist remove --comm <c> --user <id> (--bot-id <id> | --account-label <label> [--agent <a>] [--project <p>])
  agents-comm-bus allowlist list   [--comm <c>] [--scope global|per-bot|all] [--bot-id <id> | --account-label <label> [--agent <a>] [--project <p>]]
  agents-comm-bus allowlist import-from-env   [--comm telegram]
  agents-comm-bus allowlist import-from-files [--comm telegram] [--dry-run]

Diagnostics:
  agents-comm-bus status [--json] [--state-root <path>] [--discovery-root <path>]

--bot-id is canonical for per-bot commands. Label selectors are accepted only when they resolve to exactly one account.
account-add stores --bot-token in a daemon-owned file ref; credentials_ref is not user-supplied.
--account-id sets an explicit synthetic account id for comms without a probeable platform identity (e.g. curl, default curl:local); comms that probe a real identity ignore it.
`);
}
function resultSummary(result) {
    return {
        previous_bot_user_id: result.previous.bot_user_id,
        bot_user_id: result.next.bot_user_id,
        bot_changed: result.bot_changed,
        migrated_allowlist_rows: result.migrated_allowlist_rows,
        migrated_conversation_rows: result.migrated_conversation_rows,
    };
}
function relabelSummary(result) {
    return {
        previous_account_label: result.previous.account_label,
        account_label: result.next.account_label,
        bot_user_id: result.next.bot_user_id,
    };
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
//# sourceMappingURL=index.js.map