**FOR AGENTS STARTED IN THIS DIRECTORY**: You are to assist with automated end-to-end tests of the parent directory repo (the claude-code-telegram-universal-overhaul a.k.a agent-comm-bus project).

You have access to an Android emulator through the mobile-mcp tools. The emulator will have comm apps for testing installed (currently Telegram).

## Tests

### Telegram
Two bot accounts to test:
- `Refactor_Claude_Test` : connected to a Claude Code session in the parent directory
- `Refactor_Codex_Test` : connected to a Codex session in the parent directory

There is a `Group Test` group containing the two bots.

For each bot accounts, run these tests:
- *Inbound Test*: Send a message requesting a test benign query and wait for a reply
- *Outbound + Query Test*: Select an option in the query and wait for acknowledgement
- *Media Inbound Test*: Send an image from the phone's gallery with the message "what is in the image?" and wait for a reply
- *Media Outbound Test*: Request to send an image and wait for a reply
- *Channels Test*: Test group message reception: send a message in the group and wait for all bots to reply

## Output

Write each automated e2e run report as a Markdown file under `automated_e2e/`.
Use a filename that includes the date and a short scope, for example:

```text
automated_e2e/2026-05-17-telegram-e2e-report.md
```

The report must include one summary table where each row is an `agent` +
`comm` combination and each test item is a column. Use concise status markers:

- `PASS` - test completed and expected behavior was observed
- `FAIL` - test completed but expected behavior was not observed
- `BLOCKED` - test could not be run because of an external prerequisite
- `SKIP` - intentionally not run, with a short reason in the notes

Include enough evidence in the notes to make failures or blocked tests
actionable: chat name, observed reply text, selected button, timestamp,
screenshot path, log path, or relevant daemon/audit clue.

Format example:

```markdown
# Telegram E2E Report - 2026-05-17

Environment:

- Device: `emulator-5554` / `Medium Phone API 36`
- Comm app: Telegram `org.telegram.messenger.web`
- Tester: Mobile MCP

| Agent | Comm | Account / Chat | Inbound Test | Outbound + Query Test | Media Inbound Test | Media Outbound Test | Channels Test | Notes |
|---|---|---|---|---|---|---|---|---|
| Claude Code | Telegram | `Refactor_Claude_Test` | PASS | PASS | PASS | BLOCKED | PASS | Selected option 1; query resolved at 15:53. Media outbound blocked by missing fixture. |
| Codex | Telegram | `Refactor_Codex_Test` | PASS | PASS | PASS | PASS | PASS | Bot replied to Telegram-originated message; image reply observed. |

Evidence:

- Screenshots: `automated_e2e/screenshots/<run-id>/`
- Device media used: `/sdcard/Pictures/automated_e2e/`
- Relevant daemon audit entries: `<date>.jsonl`, event ids if available
```
