#!/usr/bin/env node
import { accountAdd } from "./account-add.js";
import { accountList } from "./account-list.js";
import { accountRemove } from "./account-remove.js";
import { parseMigrateArgs, runMigration } from "./migrate.js";
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
                credentialsRef: args.credentialsRef ?? args["credentials-ref"],
            });
            console.log(JSON.stringify(redact(rec), null, 2));
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
                project: required(args.project, "--project"),
                agent: required(args.agent, "--agent"),
                comm: args.comm,
                accountLabel: required(args.accountLabel ?? args["account-label"], "--account-label"),
            });
            console.log(JSON.stringify({ ok: true }, null, 2));
            return;
        }
        case "migrate": {
            const result = runMigration(parseMigrateArgs(rest));
            console.log(JSON.stringify(result, null, 2));
            return;
        }
        default:
            printHelp();
            process.exit(command ? 1 : 0);
    }
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
    console.error(`agents-comm-bus account commands

Usage:
  agents-comm-bus account-add --project <path> --agent <agent> --account-label <label> [--bot-token <token>]
  agents-comm-bus account-list [--project <path>] [--agent <agent>] [--comm telegram]
  agents-comm-bus account-remove --project <path> --agent <agent> --account-label <label> [--comm telegram]
`);
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
//# sourceMappingURL=index.js.map