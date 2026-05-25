agents-comm-bus (repo root)/
├── core-daemon/                                daemon source
│   └── bridges/
│       ├── claude/
│       │   ├── bridge.ts                       daemon-side Claude bridge entry
│       │   ├── wake.ts
│       │   └── adapter.ts
│       └── codex/
│           ├── bridge.ts                       daemon-side Codex bridge entry
│           ├── adapter.ts
│           ├── app-server.ts
│           └── app-server-lifecycle.ts
├── packages/
│   └── core-contracts/                         shared contracts/types/records/storage interfaces package
├── adapters/
│   ├── telegram/                               CommAdapter source (agent-agnostic)
│   ├── matrix/
│   ├── discord/
│   └── slack/
├── hosts/
│   ├── claude/                                 installed host edge (Claude shim + hooks + skills)
│   ├── codex/                                  installed host edge (Codex shim + hooks + skills)
│   └── common/                                 shared host-side plumbing
└── plugins/                                    BUILT ARTIFACTS
    ├── claude/
    │   ├── telegram/
    │   │   ├── .claude-plugin/
    │   │   │   └── plugin.json                 (declares MCP server + hook paths inline)
    │   │   ├── daemon.bundle.js
    │   │   ├── telegram.adapter.bundle.js
    │   │   ├── claude-install-hook.js
    │   │   ├── claude-mcp-shim.js
    │   │   └── skills/
    │   │       └── telegram/
    │   │           └── SKILL.md
    │   ├── matrix/
    │   │   └── ...
    │   ├── discord/
    │   └── slack/
    └── codex/
        ├── telegram/
        │   ├── .codex-plugin/
        │   │   └── plugin.json                 (manifest; per Codex plugin spec)
        │   ├── .mcp.json                       (MCP server config; separate file per Codex spec)
        │   ├── hooks/
        │   │   └── codex-install-hook.js       (Codex convention: lifecycle hooks under hooks/)
        │   ├── daemon.bundle.js
        │   ├── telegram.adapter.bundle.js
        │   ├── codex-mcp-shim.js
        │   └── skills/
        │       └── telegram/
        │           └── SKILL.md
        ├── matrix/
        │   └── ...
        ├── discord/
        └── slack/

agents-comm-bus-claude (repo root)/
└── .claude-plugin/
    └── marketplace.json                         (entries reference agents-comm-bus#<tag>:plugins/claude/<comm>)

agents-comm-bus-codex (repo root)/
└── .agents/
    └── plugins/
        └── marketplace.json                     (entries reference agents-comm-bus#<tag>:plugins/codex/<comm>)

Notes:
- `core-daemon/bridges/<agent>/` means daemon-side agent protocol handlers, not host/plugin glue.
- `hosts/<agent>/` remains the installed edge for MCP shims, hooks, skills, and manifest wiring.
- When referring to bridge entry files in docs/reviews/plans, use the full path (for example `core-daemon/bridges/claude/bridge.ts`), never bare `bridge.ts`.
