agents-comm-bus (repo root)/
├── core/                                       daemon source
├── adapters/
│   ├── telegram/                               CommAdapter source (agent-agnostic)
│   ├── matrix/
│   ├── discord/
│   └── slack/
├── hosts/
│   ├── claude/                                 AgentAdapter source (Claude host glue)
│   └── codex/                                  AgentAdapter source (Codex host glue)
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
    │   │       └── telegram.md
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
        │       └── telegram.md
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
