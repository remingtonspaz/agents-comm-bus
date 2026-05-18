# Adapter modularization — proposal

**Status:** proposal, post-V1 follow-up
**Author origin:** synthesized from a Telegram discussion between the human and Claude on 2026-05-17 and 2026-05-18.

## Motivation

The architecture in [storage layout](../storage-layout.md), [invariants](../invariants.md), and the v4 RFC has a clean adapter boundary — `AgentAdapter` for each agent host, `CommAdapter` for each comm channel. The recent code reorg under `agents-comm-bus/adapters/{agents,comms}/` already places each adapter in its own folder.

The next question: **should adapters be modular install units, not just modular code units?** Goal is **user install footprint reduction**, not enabling third-party adapter authoring. Different goal, different design constraints, different stopping point.

## What the footprint actually costs

The adapter code itself is small — 200–700 LoC per adapter, roughly 5–20 KB after bundling. That is not the cost worth optimizing.

The real install-footprint cost is **per-adapter platform SDK dependency trees**:

| Adapter | SDK | Approximate bundled size |
|---|---|---|
| Telegram | `node-telegram-bot-api` + transitives | ~3 MB |
| Matrix (planned) | `matrix-bot-sdk` | similar order |
| Discord (planned) | `discord.js` | ~5–10 MB |
| Slack (planned) | Slack SDK | similar to Discord |

A user who installs only the Telegram-shipping plugin has no reason to carry the Matrix / Discord / Slack SDKs. With today's single-bundle daemon, every install pays the full SDK cost regardless of which comms the user actually uses.

That is what modularization should fix.

## Proposed phasing

Three plausible levels of modularization, ranked by increasing investment. The right ceiling for this goal is **Level 2**.

### Level 1 — Per-adapter folders, single daemon bundle (current state)

- Each adapter lives in its own folder under `agents-comm-bus/adapters/{agents,comms}/<name>/`. ✓ Already done.
- All adapters bundle into one daemon binary at build time.
- All platform SDKs ship in every install.
- No code-organization or boundary problem; only an install-size problem.

This is the state immediately after the `f91bfd0` reorg. Acceptable for early phases; insufficient for the footprint goal.

### Level 2 — Plugin-driven adapter selection (proposed target)

- Each marketplace plugin (`claude-code-telegram`, future `claude-code-matrix`, etc.) bundles the daemon binary **plus only the adapters that plugin needs**.
- A plugin shipping just Telegram has only the Telegram CommAdapter + its SDK; the daemon binary is otherwise identical.
- Daemon at startup scans installed plugin paths for adapter manifests and loads what it finds.
- All adapters remain first-party. Trust model unchanged. No public ABI.

This is the smallest design that hits the footprint goal.

### Level 3 — Independent adapter packages with stable ABI (out of scope)

- Adapters published as separately-versioned npm packages.
- Daemon declares an `adapter_abi_version`; each adapter manifests its required version.
- Optional sandboxing (workers / separate processes) once third parties can author adapters.
- Capability discovery, runtime registry, deprecation policy.

Skipped. The goal was not third-party authoring; investing in stable ABI + sandboxing before the interfaces have settled would be premature.

## Level 2 — concrete design

### Plugin layout

Each marketplace plugin ships its own daemon binary plus its own selection of adapters:

```
~/.claude/plugins/cache/<source>/<plugin>/<version>/
├── agents-comm-bus/
│   ├── daemon.js                # identical across plugins shipping the same daemon version
│   └── adapters/
│       ├── agents/
│       │   └── claude/          # or codex, etc. — only the ones this plugin needs
│       │       ├── adapter.json # manifest
│       │       ├── index.js
│       │       └── node_modules/
│       └── comms/
│           └── telegram/        # this plugin only needs the Telegram CommAdapter
│               ├── adapter.json
│               ├── index.js
│               └── node_modules/  # node-telegram-bot-api lives here, not in core
```

Adapters that are not bundled with a plugin are simply absent from disk. Their SDKs are not installed. That is the footprint win.

A user with both `claude-code-telegram` and a future `claude-code-matrix` plugin installed has two on-disk copies of `daemon.js` (already tolerated under the v4 [daemon binary distribution rule](../sequence-daemon-bootstrap.md)) plus disjoint adapter sets, and the live daemon merges them at startup discovery.

### Adapter manifest

Every adapter folder carries an `adapter.json`:

```json
{
  "id": "telegram",
  "kind": "comm",
  "entry": "./index.js",
  "displayName": "Telegram",
  "schema_version": 1
}
```

The fields are deliberately minimal for Level 2:

- `id`: unique within `kind`. Used as the `CommId` / `AgentId` value at runtime.
- `kind`: `"comm" | "agent"`. Determines which router consumes it.
- `entry`: path to the loadable module, relative to the manifest.
- `displayName`: human-readable; used in diagnostics and CLI output.
- `schema_version`: bumped only when the manifest format itself changes, **not** when the adapter's internal data changes. Stable for the life of Level 2.

No capability flags, no ABI version, no required-bus-version. The trust assumption is "this adapter was built against the same daemon source tree." Daemon and adapter ship together inside one plugin install.

### Daemon startup discovery

On startup, after the existing bootstrap from [daemon bootstrap](../sequence-daemon-bootstrap.md), the daemon walks every known plugin install path looking for `agents-comm-bus/adapters/{agents,comms}/*/adapter.json`. The set of paths to scan is:

1. The plugin install path the daemon was spawned from (always present).
2. Any other plugin install paths cooperatively listed in a small registry file: `~/.agents-comm-bus/plugins.json`. Each plugin writes its own install path on first activation; the daemon also accepts updates via the IPC protocol when a new plugin first connects.

Loading is just `await import(manifest.entry)`; the module is expected to export a default that satisfies the relevant `AgentAdapter` / `CommAdapter` interface. Adapter registration with the router happens in core after import.

Conflict handling: if two plugins ship the same `(kind, id)`, daemon prefers the first one loaded (deterministic order: lexicographic plugin install path), and writes a clear warning to `audit/audit-YYYY-MM-DD.jsonl`. This is a soft conflict — both plugins built against the same source tree should produce equivalent adapters — and not worth more rigor than logging at Level 2.

### Per-adapter SDK isolation

The win depends on each adapter's `node_modules` being independent. Build-time options:

- **Per-adapter bundling (recommended).** Each adapter is independently bundled with esbuild; its SDK is tree-shaken into a single output file. The daemon imports the bundled output, not the source. No shared `node_modules`; the SDK exists only when the adapter exists.
- Per-adapter `node_modules` directory (no bundling). Simpler build, larger on-disk size, slower load. Acceptable fallback.

The build pipeline already produces a single bundled `daemon.js`; extending it to produce one bundled `<adapter>/index.js` per adapter is a small step.

### Cross-plugin coordination

The v4 [daemon bootstrap](../sequence-daemon-bootstrap.md) sequence is unchanged: first hook activation spawns the daemon from its own plugin's binary; subsequent activations connect to the running daemon. With Level 2:

- The first-spawning plugin contributes its own adapters via local-folder scan.
- Subsequent plugins (different telegram-vs-matrix shape) connect to the live daemon and announce themselves; daemon scans the connecting plugin's install path and loads any not-yet-present adapters.
- Plugin uninstall does not affect the live daemon process. On next restart the daemon will only load adapters from currently-installed plugins.

This makes "install a new plugin → get its adapters" a single-restart operation, not "tear everything down and reinstall."

## What does and doesn't change

### Stays the same

- `AgentAdapter` / `CommAdapter` interfaces. No version negotiation, no capability discovery beyond what's already in the interface (`canWake`, etc.).
- Routing, query lifecycle, conversation inventory, audit format, storage schema.
- All [invariants](../invariants.md). Modularization is a packaging change; the bus contract is unchanged.
- Plugin install / spawn protocol from [daemon bootstrap](../sequence-daemon-bootstrap.md).

### Changes

- Build pipeline grows per-adapter bundling targets.
- Daemon adds startup discovery via `~/.agents-comm-bus/plugins.json` + per-plugin folder scan.
- New CLI surface: `agents-comm-bus adapters list` to show what's loaded and from which plugin install.
- Audit log gains an `adapter_loaded` event per registration.

## What this proposal explicitly does **not** ask for

These belong to Level 3 and are out of scope unless the goal changes from footprint to ecosystem:

- Stable ABI versioning across daemon and adapter releases.
- Adapter sandboxing / worker-thread isolation.
- A registry / marketplace for third-party adapters.
- Capability discovery via manifest beyond the static `kind` field.
- Hot-reload of adapters at runtime.

## Suggested phasing relative to current implementation

- **Phase 1 (current — daemon spike + Telegram only):** Level 1 is sufficient. No modularization work needed.
- **Phase 2 (ClaudeAgentAdapter wrap):** Level 1 is still sufficient. Code-organization-wise the folders are already separable.
- **Phase 3 (CodexAgentAdapter):** Level 1 is still sufficient. Footprint is not yet noticeably bad — only one comm (Telegram) ships.
- **Phase 3.5 — adopt Level 2 here, *before* Matrix lands.** The pre-Matrix moment is the cheapest time to introduce modular adapter loading, because there is still only one CommAdapter to migrate as a reference implementation. Doing it now de-risks the multi-CommAdapter case in phase 4.
- **Phase 4 (Matrix lands as second comm):** Level 2 already in place. Matrix ships as part of a separate plugin (or the same plugin with both adapters; either works under Level 2). The user install of a Telegram-only plugin remains Telegram-SDK-only.
- **Phase 5 (opt-in service install):** Unaffected.

## Open questions

1. **Plugin manifest format for declaring shipped adapters.** Today the plugin manifest (`.claude-plugin/plugin.json` and the Codex equivalent) does not declare anything about adapter contents. Daemon discovery uses folder presence, which works, but a plugin-manifest declaration would let the daemon issue a clearer error when an expected adapter is missing.
2. **Adapter version pinning across plugins.** If two plugins ship the same `(kind, id)` at different code versions (e.g. one plugin was upgraded but the other wasn't), what's the behavior? Today: lexicographic first-wins with audit log. Acceptable for Level 2 since both plugins are first-party against the same source tree; revisit if it becomes a real problem.
3. **Cross-plugin daemon binary versioning.** Already a concern under the v4 spawn protocol — the live daemon is whichever was spawned first. Modularization doesn't add new problems here; it just makes "daemon binary version" and "adapter set" two axes instead of one.

## Status and next action

- Proposal only. No code changes implied until phase 3.5.
- If phase 3 (CodexAgentAdapter) lands and the team agrees, Level 2 work can begin as a small, contained migration: extract Telegram into its own bundled output, add the discovery scanner, smoke-test against a single-plugin install.
- Re-evaluate Level 3 only if external adapter contributors materialize, which is explicitly out of the current product goal.
