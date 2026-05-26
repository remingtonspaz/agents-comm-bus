---
name: telegram-integration
description: Telegram integration for Claude Code through the agents-comm-bus daemon.
skillName: telegram-integration
metadata:
  hermes:
    tags: [telegram, claude-code, mcp, messaging]
    related_skills: []
---

# Telegram Integration for Claude Code

This skill enables bidirectional communication with Telegram.

## IMPORTANT: Always Forward to Telegram

**You MUST use the `comm_send_message` tool with `comm: "telegram"` to forward your responses to Telegram.** The user monitors this session remotely via Telegram and needs to see what you're doing.

### Communication Pattern
1. **First**: Send an initial acknowledgment/plan when you receive a message
2. **During**: Send milestone updates for important progress (found the issue, making changes, tests passing, etc.)
3. **Finally**: Send a summary of what was completed

Keep Telegram messages concise but informative.

## Quick Status Check

To verify the integration is working, check the MCP server status:
```
/mcp
```

Look for the `telegram` server in the list. If it shows as connected, the integration is active.

## Installation

If the integration isn't set up yet:

1. Install the plugin: `/plugin install telegram`
2. Configure credentials in `.mcp.json`
3. Restart Claude Code to load the MCP server

## Troubleshooting

### MCP server not showing in /mcp
1. Check that `agents-comm-bus` package is built (`cd agents-comm-bus && npm run build`)
2. Verify `.mcp.json` exists in the project root
3. Restart Claude Code

### Messages not being received
1. Check the daemon is running: `node agents-comm-bus/dist/core-daemon/cli/index.js account-list`
2. Verify the bot token is valid
3. Make sure you're messaging from the authorized Telegram user ID

### Send failing
1. Check the bot token in `.mcp.json`
2. Verify the user ID is correct
3. Check MCP server logs in Claude Code output

## Configuration

- Bot credentials: `.mcp.json` in project root
- Hook configuration: `.claude/settings.local.json`
- Daemon state: `~/.agents-comm-bus/`

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

1. **Outbound (Agent to Telegram)**: Call `comm_send_message` or `comm_send_attachment` with `comm: "telegram"`
2. **Inbound (Telegram to Agent)**: Messages are automatically injected as context before each prompt via a UserPromptSubmit hook
