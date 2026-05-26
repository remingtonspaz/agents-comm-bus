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
│   ├── claude/                                 installed host edge source (Claude shim + hooks + skill inputs)
│   ├── codex/                                  installed host edge source (Codex shim + hooks + skill inputs)
│   └── common/                                 shared host-side plumbing + shared skill authoring inputs
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
- `hosts/<agent>/` remains the installed edge source for MCP shims, hooks, host-facing skill inputs, and manifest wiring.
- Source-side skill authoring inputs may live under `hosts/common/skills/**` and `hosts/<agent>/skills/<comm>/**`, but that authoring layout is not a shipped plugin contract. Assembly/staging must emit self-contained plugin artifacts.
- Shipped plugin skills use directory-form skill packaging: `skills/<skill-name>/SKILL.md` plus optional supporting files under that skill directory. For Phase 7 Track 2 the Telegram skill-name is pinned to `telegram`, so both Claude and Codex Telegram artifacts must stage the skill at `plugins/<agent>/telegram/skills/telegram/SKILL.md` (installed as `skills/telegram/SKILL.md` inside the plugin), never as a flat `skills/telegram.md` or copied verbatim from source-side fragments.
- When referring to bridge entry files in docs/reviews/plans, use the full path (for example `core-daemon/bridges/claude/bridge.ts`), never bare `bridge.ts`.
