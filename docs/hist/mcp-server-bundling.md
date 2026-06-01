# MCP server bundling (session 3, still applies)

- `mcp-server` is bundled to a single file via `esbuild` so no `node_modules`
  is needed at runtime (3 MB bundle vs 46 MB modules).
- `node-telegram-bot-api` is CJS, the source is ESM, so the bundle needs:
  ```
  --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
  ```
  Required for Node 24+; without it, CJS deps crash at runtime when they call
  `require`.
