# Marketplace Release Readiness

This checklist gates publishing `universal-overhaul` as `main` or updating the
Claude/Codex marketplace repositories. It is intentionally marketplace-first:
source/dev setup can work while production install is still blocked.

## Current Blocker

Do not publish while `tests/architecture/production-install.test.ts` contains
`todo` release-gate checks. Those expected failures mean fresh marketplace
artifacts are not yet self-contained.

AGE-23 owns the runtime packaging fix:

- production `entryEnsures` succeeds against real staged plugin artifacts;
- staged daemon entry loads from an isolated copy outside the repository;
- staged hook entries that import daemon-facing code also load in isolation;
- the release-gate tests are parametrized across Claude and Codex where useful;
- the `todo` markers are removed so production install regressions fail hard.

AGE-24 owns this document, the README release path, manifest/version
presentation, and known-caveat wording.

## Release Checklist

- Root `npm test` passes with no failing tests and no production-install `todo`
  release gates.
- `npm --workspace agents-comm-bus run typecheck` passes.
- `npm run stage:plugins:verify` passes.
- The staged Claude plugin in `plugins/claude/telegram` is the artifact intended
  for the Claude marketplace repository.
- The staged Codex plugin in `plugins/codex/telegram` is the artifact intended
  for the Codex marketplace or personal marketplace entry.
- README marketplace installation steps match the staged artifact layout.
- README source-development steps are clearly secondary and not presented as the
  marketplace path.
- `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`,
  `.codex-plugin/plugin.json`, and staged `install-stamp.json` files tell a
  coherent version story.
- Release notes mention Node 22+, Telegram bot token requirements, terminal
  `account-add`, and the per-user daemon state root.
- Release notes mention current caveats: Windows-only Claude auto-wake, Claude
  SessionStart seed behavior, Codex PermissionRequest auto-mode tradeoff, and
  terminal-based first-run account setup.

## Version Metadata Policy

There are three version axes:

- Plugin version: the host-visible Telegram plugin version. This should match
  `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, marketplace
  metadata, and `install-stamp.json` `plugin_version` for a release.
- Daemon bundle version: the content version used by central install to decide
  whether the shared daemon artifact should be replaced.
- Adapter bundle version: the content version used by central install to decide
  whether the Telegram adapter artifact should be replaced.

The root `package.json` version is the source workspace version. It is not a
marketplace plugin version unless a release explicitly chooses to align them.

Central install must key blob replacement on daemon/adapter bundle versions, not
on plugin version. A plugin hotfix can therefore update host metadata without
downgrading a newer shared daemon or adapter blob.

## Marketplace User Path

The primary user path after AGE-23 is:

1. Install the host plugin from the marketplace.
2. Restart the host agent so MCP servers and hooks load.
3. Register the Telegram bot with the staged daemon CLI:

   ```powershell
   node <plugin-root>\agents-comm-bus\dist\core-daemon\cli\index.js account-add `
     --project "<absolute project path>" `
     --agent claude `
     --account-label main `
     --bot-token "<telegram bot token>"
   ```

4. Message the bot once in Telegram.
5. Verify MCP tools are visible and `list_conversations` works after the first
   inbound message.

Codex uses the same registration shape with `--agent codex`.

## Known Caveats To Carry Into Release Notes

- Claude auto-wake is Windows-only today because it uses PowerShell and console
  `WM_CHAR` posting.
- Claude `SessionStart` can miss first-session setup on Windows due to an
  upstream Claude Code harness issue; first prompt may need a manual seed.
- Codex `PermissionRequest` hooks can disable Codex auto-mode classification.
  Use local Codex permission handling when auto-mode continuity matters more
  than Telegram-routed permission prompts.
- First-run account registration is a terminal command. There is no in-agent
  account onboarding flow yet.
- The daemon is per-user. One live daemon owns all registered comm adapters for
  that user.

## Non-Goals For This Release

- Service installation. The daemon remains lazy-spawned by hooks/MCP calls.
- A graphical account-registration flow.
- Non-Windows Claude auto-wake.
- Removing transition-only credential discovery fallbacks tracked separately.
