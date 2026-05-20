#!/usr/bin/env node
import { accountAdd } from "./account-add.js";
import { accountList } from "./account-list.js";
import { accountRemove } from "./account-remove.js";
import { allowlistAdd } from "./allowlist-add.js";
import {
  allowlistImportFromEnv,
  allowlistImportFromFiles,
} from "./allowlist-import.js";
import { allowlistList, type AllowlistScopeFilter } from "./allowlist-list.js";
import { allowlistRemove } from "./allowlist-remove.js";
import { parseMigrateArgs, runMigration } from "./migrate.js";
import { reloadDaemonRegistrations } from "./reload-helper.js";

async function main(): Promise<void> {
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
        project: required(args.project, "--project"),
        agent: required(args.agent, "--agent"),
        comm: args.comm,
        accountLabel: required(args.accountLabel ?? args["account-label"], "--account-label"),
      });
      const reload = await reloadDaemonRegistrations();
      console.log(JSON.stringify({ ok: true, reload }, null, 2));
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
    default:
      printHelp();
      process.exit(command ? 1 : 0);
  }
}

async function handleAllowlist(rest: string[]): Promise<void> {
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
        project: args.project ?? (scope === "per-bot" && !(args.botId ?? args["bot-id"]) ? process.cwd() : undefined),
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
        project: args.project ?? (scope === "per-bot" && !(args.botId ?? args["bot-id"]) ? process.cwd() : undefined),
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
        scope: scopeArg as AllowlistScopeFilter | undefined,
        botId: args.botId ?? args["bot-id"],
        agent: args.agent,
        project:
          args.project ??
          (args.agent && !(args.botId ?? args["bot-id"]) ? process.cwd() : undefined),
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

function allowlistScopeFromArgs(args: Record<string, string | undefined>): "global" | "per-bot" {
  const hasPerBotSelector = Boolean(
    args.botId ?? args["bot-id"] ?? args.agent ?? args.project ?? args.accountLabel ?? args["account-label"],
  );
  return hasPerBotSelector ? "per-bot" : "global";
}

function parseArgs(args: string[]): Record<string, string | undefined> {
  const parsed: Record<string, string | undefined> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = args[i + 1]?.startsWith("--") ? undefined : args[++i];
    parsed[key] = value;
    parsed[key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  return parsed;
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function redact<T extends { credentials_ref?: string }>(row: T): T {
  return { ...row, credentials_ref: row.credentials_ref ? "[redacted]" : row.credentials_ref };
}

function printHelp(): void {
  console.error(`agents-comm-bus CLI

Account commands:
  agents-comm-bus account-add --project <path> --agent <agent> --account-label <label> [--bot-token <token>]
  agents-comm-bus account-list [--project <path>] [--agent <agent>] [--comm telegram]
  agents-comm-bus account-remove --project <path> --agent <agent> --account-label <label> [--comm telegram]

Allowlist commands:
  agents-comm-bus allowlist add    --comm <c> --user <id> [--note "..."]                            # global
  agents-comm-bus allowlist add    --comm <c> --user <id> --bot-id <id>                             # per-bot (canonical)
  agents-comm-bus allowlist add    --comm <c> --user <id> --agent <a> [--account-label <l>] [--project <p>]
                                                                                                    # per-bot (resolved)
  agents-comm-bus allowlist remove --comm <c> --user <id> [--bot-id <id> | --agent <a> [--project <p>]]
  agents-comm-bus allowlist list   [--comm <c>] [--scope global|per-bot|all] [--bot-id <id> | --agent <a> ...]
  agents-comm-bus allowlist import-from-env   [--comm telegram]
  agents-comm-bus allowlist import-from-files [--comm telegram] [--dry-run]

For per-bot scope without --bot-id, --project defaults to the current working directory.
--account-label defaults to "main".
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
