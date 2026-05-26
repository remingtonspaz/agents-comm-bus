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
