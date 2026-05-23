---
name: telegram-integration
description: Set up, check status, or use the Telegram integration for Agents. Use this skill when the user mentions Telegram, wants to send messages to Telegram, check Telegram status, or troubleshoot Telegram connectivity. This skill should be active for ALL sessions in this project.
---

# Telegram Integration for Agents

This skill enables bidirectional communication with Telegram.

---

**Note**: If your prompt is just `.` - that means a Telegram message triggered the auto-enter. Check the `[Telegram Messages Received]` section in your context for the actual message.

---

## IMPORTANT: Always Forward to Telegram

**You MUST use the `comm_send_message` tool with `comm: "telegram"` to forward your responses to Telegram.** The user monitors this session remotely via Telegram and needs to see what you're doing.

### Communication Pattern
1. **First**: Send an initial acknowledgment/plan when you receive a message
2. **During**: Send milestone updates for important progress (found the issue, making changes, tests passing, etc.)
3. **Finally**: Send a summary of what was completed

### Example Flow
```
User sends Telegram message: "Fix the bug in auth.js"

Agent sends to Telegram: "Looking at auth.js to fix the bug..."
Agent reads files, investigates
Agent sends to Telegram: "Found it - the token validation is missing a null check"
Agent makes edits
Agent sends to Telegram: "Fixed! Added null check on line 42. Ready for testing."
```

Keep Telegram messages concise but informative.

## Quick Status Check

To verify the integration is working, check the MCP server status:
```
/mcp
```

Look for the `telegram` server in the list. If it shows as connected, the integration is active.

## Available Tools

Once the MCP server is running, you have access to these tools:

### comm_send_message
Send a text message to Telegram.
```
Use the comm_send_message tool with comm: "telegram", message: "Your message here"
```

### comm_send_attachment
Send an image file to Telegram.
```
Use the comm_send_attachment tool with comm: "telegram", path: "/absolute/path/to/image.png" and optional caption
```

### comm_check_messages
Manually check for pending messages (messages are also auto-injected on each prompt).
```
Use the comm_check_messages tool with comm: "telegram"
```

When you need to target a specific Telegram chat or topic, use the nested
`target` object shape: `{ chat_native_id, thread_native_id? }`. The shim no
longer accepts flat `chat_id` / `message_thread_id` fields.

## How It Works

1. **Outbound (Agent to Telegram)**: Call the `comm_send_message` or `comm_send_attachment` tools with `comm: "telegram"`
2. **Inbound (Telegram to Agent)**: Messages are automatically injected as context before each prompt via a UserPromptSubmit hook

## Installation

If the integration isn't set up yet:

1. Install the plugin: `/plugin install telegram`
2. Configure credentials in `.mcp.json`
3. Restart Claude Code to load the MCP server

## Troubleshooting

### MCP server not showing in /mcp
1. Check that `mcp-server/node_modules` exists (run `cd mcp-server && npm install`)
2. Verify `.mcp.json` exists in the project root
3. Restart Claude Code

### Messages not being received
1. Check the queue file: `~/.claude-telegram/queue.json`
2. Verify the bot token is valid
3. Make sure you're messaging from the authorized Telegram user ID

### Send failing
1. Check the bot token in `.mcp.json`
2. Verify the user ID is correct
3. Check MCP server logs in Claude Code output

## Configuration

- Bot credentials: `.mcp.json` in project root
- Hook configuration: `.claude/settings.local.json`
- Message queue: `~/.claude-telegram/queue.json`
