> Drafted 2026-05-18, expanded 2026-05-19 with terminology, marketplace
> distribution, and reference-counted install metadata. Status: proposal,
> not ratified. Open TBDs flagged at the bottom.

# Plugin install model for the `agents-comm-bus` family

This doc captures the install/distribution shape the daemon and its
adapters are proposed to take. It sits underneath
[`architecture/invariants.md`](../architecture/invariants.md) — the
invariants describe runtime contracts; this doc describes how the bits
get onto the user's machine in the first place.

## Decision

**Peer-class plugin per comm.** There is no standalone `agents-comm-bus`
plugin. Each agent's marketplace ships one plugin per supported comm:

- `agents-comm-bus-telegram`
- `agents-comm-bus-matrix`
- `agents-comm-bus-discord`
- `agents-comm-bus-slack`
- (future: one per added comm)

Each plugin is a self-sufficient install. Installing any one of them
brings up the daemon if it isn't already running, registers the plugin's
adapter, and the user is ready to register accounts on that comm.

## Architectural terminology

Two perpendicular kinds of "adapter" exist in v4. They live in different
places and serve different roles; conflating them confuses the install
discussion:

| Adapter | Lives where | Role |
|---|---|---|
| **CommAdapter** (Telegram, Matrix, Discord, Slack) | shared: `~/.agents-comm-bus/adapters/<comm>.js` | Translates platform specifics (`getUpdates`, `/sync`, Discord Gateway, Slack Socket Mode) ↔ core `InboundMessage` / `OutboundMessage` types. **Agent-agnostic by design.** |
| **AgentAdapter** (Claude, Codex, future) | per-agent plugin install path: `~/.claude/plugins/.../{mcp-shim,install-hook}` or `~/.codex/plugins/.../{mcp-shim,install-hook}` | Translates host harness specifics (Claude Code hooks + MCP + skill format, Codex hooks + app-server + skill format) ↔ daemon WS protocol. **Comm-agnostic by design.** |

The daemon itself only knows the AgentAdapter *protocol* (WS handshake +
control messages). Claude and Codex are both WS clients identifying
themselves at handshake; the daemon contains no per-agent code. Adding a
new agent (e.g., Gemini) requires zero changes to the daemon or to any
existing CommAdapter — only a new flavor of AgentAdapter (hooks +
MCP shim) shipped via that agent's marketplace.

## Why peer-class instead of "core + adapters"

An earlier shape considered shipping a privileged `agents-comm-bus` core
plugin (daemon + Telegram bundled, since Telegram is the migration
anchor) with `agents-comm-bus-matrix`, `-discord`, `-slack` as add-on
plugins that dropped their adapters into the core's runtime directory.
That shape was rejected because:

1. **Architectural backsliding.** The overhaul exists specifically to
   retire "Telegram is THE comm." Bundling Telegram into a privileged
   core re-introduced exactly that asymmetry at the install layer, even
   though the runtime was symmetric.
2. **Cross-plugin dependencies are weakly expressed.** Claude Code's
   marketplace doesn't have a robust "this plugin requires that one"
   contract. Peer-class plugins sidestep the problem — each plugin is
   independently installable.
3. **Migration becomes explicit.** Existing `claude-code-telegram` users
   uninstall the old plugin and install `agents-comm-bus-telegram` —
   one named, deliberate step rather than implicit bundling.
4. **One plugin anatomy to maintain.** Every comm plugin has the same
   shape (see below). No special "core" type.

## Each plugin's payload

`~/.claude/plugins/agents-comm-bus-<comm>/` (mirrored at
`~/.codex/plugins/agents-comm-bus-<comm>/` for the Codex flavor):

| File | Category | Purpose |
|---|---|---|
| `daemon.bundle.js` | agent-agnostic | esbuilt daemon core. **Byte-identical** across the family (built from the same monorepo). Each plugin ships its own copy. |
| `<comm>.adapter.bundle.js` | agent-agnostic | esbuilt CommAdapter for this one comm. Loaded dynamically by the daemon at runtime. |
| `<agent>-install-hook.js` (Claude, at plugin root) or `hooks/<agent>-install-hook.js` (Codex) | agent-specific | Plugin lifecycle hook (e.g., Claude Code's `UserPromptSubmit`) that bootstraps the daemon if missing and drops the adapter into the shared location. Uses that agent's hook contract. Codex convention is to nest hooks in a `hooks/` directory; Claude declares the path inline in `plugin.json` so the script can live at root. |
| `<agent>-mcp-shim.js` | agent-specific | Thin MCP server that brokers `register_account`, `send_message`, etc. between the agent and the daemon's WS. This **is** the AgentAdapter implementation for this host. |
| `skills/<comm>.md` | agent-specific | Setup walkthrough that the host agent's skill system can read. Both Claude and Codex use a `skills/` subdir per their respective plugin specs. |
| `.claude-plugin/plugin.json` (Claude) or `.codex-plugin/plugin.json` + `.mcp.json` (Codex) | agent-specific | Plugin manifest. Claude declares MCP server, hook paths, and skill all inside `.claude-plugin/plugin.json`. Codex splits these — manifest at `.codex-plugin/plugin.json`, MCP server config at `.mcp.json`, lifecycle hooks under `hooks/`. Both paths verified against each agent's plugin-format spec. |

Disk cost: ~3 MB per plugin (the daemon bundle dominates). With four
comms × two agents = ~24 MB across `~/.claude/plugins/` and
`~/.codex/plugins/` combined. Trivial.

## Shared install location

`~/.agents-comm-bus/`:

| Path | Owner | Purpose |
|---|---|---|
| `bin/daemon.js` | dropped by whichever plugin's install hook has the newest version on disk | the running daemon binary |
| `bin/version.json` | install hooks | reference-counted metadata (see below) |
| `adapters/<comm>.js` | the corresponding comm plugin's install hook | adapter blob, loaded dynamically by the daemon |
| `adapters/<comm>.version.json` | install hook | reference-counted metadata, same shape as `bin/version.json` |
| `agents-comm-bus.db` | daemon | SQLite + JSON1 — `account_registrations`, `conversations`, `queries`, `sessions` |
| `transcripts/...` | daemon | JSONL append-only |
| `attachments/...` | daemon | content-addressed blobs |
| `port` | daemon | discoverable WS port |

This layout cleanly separates **code** (`bin/`, `adapters/`) from
**state** (`db`, `transcripts/`, `attachments/`). A user who wants to
"reset state" can drop the state subtrees without touching code; a user
who wants to "reset everything" drops the whole directory and on next
prompt the install hooks reinstall the code from plugin install paths.

### Reference-counted install metadata

Because both `~/.claude/plugins/agents-comm-bus-<comm>/` and
`~/.codex/plugins/agents-comm-bus-<comm>/` (and any future agent's
equivalent) may all try to install the same shared file, the metadata
file is a **list of installers**, not a single string:

```json
{
  "version": "1.2.0",
  "installed_by": [
    { "agent": "claude", "plugin_version": "1.2.0", "installed_at": "2026-05-18T20:25:00Z" },
    { "agent": "codex",  "plugin_version": "1.1.5", "installed_at": "2026-05-19T03:18:00Z" }
  ]
}
```

The actual file content reflects the **highest** `plugin_version` across
all entries. Install hooks **add** their entry on install (replacing any
prior entry for that same `agent`); uninstall hooks **remove** their
entry. When the `installed_by` list goes empty, the file is safe to
clean up (probably with a confirm prompt — see open questions).

Install hooks are themselves agent-specific (Claude Code's hook contract
differs from Codex's — different env vars, different stdin envelope,
different invocation signature), so each hook self-identifies; no
runtime detection of "which agent am I" is needed.

## Repo layout and distribution

Three repos total. Both **source code AND built artifacts** live in the
single source monorepo; the marketplace repos are thin pointer files
that reference the monorepo via **git-subdir** (a subdirectory of a git
URL — supported by both Claude Code and Codex's marketplace manifest
formats).

See [`dist-tree-plan.md`](./dist-tree-plan.md) for the canonical
directory sketch this section follows.

| Repo | Role |
|---|---|
| `agents-comm-bus` | Source monorepo with source dirs **and** built artifacts. Sources: `core/` (daemon), `adapters/<comm>/` (CommAdapter), `hosts/<agent>/` (AgentAdapter). Built artifacts: `claude/<comm>/`, `codex/<comm>/` — one subdir per `(agent, comm)` pair, ready for marketplace consumption via git-subdir. **No marketplace manifest at any path** in this repo. |
| `agents-comm-bus-claude` | Distribution endpoint for Claude Code. Contains only `.claude-plugin/marketplace.json` referencing `agents-comm-bus#<tag>:claude/<comm>` per plugin. |
| `agents-comm-bus-codex` | Distribution endpoint for Codex. Contains only `.agents/plugins/marketplace.json` referencing `agents-comm-bus#<tag>:codex/<comm>` per plugin. |

### Monorepo structure (Option A — preferred)

A `plugins/` parent groups the built-artifact subtrees away from the
source dirs, so navigating the repo immediately distinguishes "this is
source" from "this is what gets shipped":

```
agents-comm-bus/                       (single monorepo)
├── core/                              daemon source
├── adapters/
│   ├── telegram/                      CommAdapter source (agent-agnostic)
│   ├── matrix/
│   ├── discord/
│   └── slack/
├── hosts/
│   ├── claude/                        AgentAdapter source: hooks + MCP shim
│   └── codex/                         (host glue for each agent)
├── plugins/                           BUILT ARTIFACTS
│   ├── claude/
│   │   ├── telegram/
│   │   │   ├── .claude-plugin/plugin.json
│   │   │   ├── daemon.bundle.js
│   │   │   ├── telegram.adapter.bundle.js
│   │   │   ├── claude-install-hook.js
│   │   │   ├── claude-mcp-shim.js
│   │   │   └── skills/telegram.md
│   │   ├── matrix/
│   │   ├── discord/
│   │   └── slack/
│   └── codex/
│       ├── telegram/
│       │   ├── .codex-plugin/plugin.json   (verified per Codex plugin spec)
│       │   ├── .mcp.json                    (Codex declares MCP servers here, not inside plugin.json — verified per spec)
│       │   ├── hooks/
│       │   │   └── codex-install-hook.js   (Codex convention is hooks/<file>)
│       │   ├── daemon.bundle.js
│       │   ├── telegram.adapter.bundle.js
│       │   ├── codex-mcp-shim.js
│       │   └── skills/telegram.md
│       └── ... (matrix, discord, slack)
└── package.json, .gitattributes, CI configs
```

The Codex per-plugin layout differs slightly from Claude's because
Codex's plugin format (verified at
[developers.openai.com/codex/plugins/build](https://developers.openai.com/codex/plugins/build))
documents conventional locations: `.codex-plugin/plugin.json` for the
manifest, `.mcp.json` for MCP server config (separate from the
manifest), `hooks/` for lifecycle hooks, `skills/` for skills, and
optionally `.app.json` for apps/connectors (not used by this family).
Claude's plugin format declares hook and MCP-server paths inside
`.claude-plugin/plugin.json` directly, so the hook script can live at
the plugin root.

### Marketplace repo shape (thin pointers)

```
agents-comm-bus-claude/
└── .claude-plugin/marketplace.json    (entries reference agents-comm-bus#<tag>:plugins/claude/<comm>)

agents-comm-bus-codex/
└── .agents/plugins/marketplace.json   (entries reference agents-comm-bus#<tag>:plugins/codex/<comm>)
```

When the user runs `/plugin install agents-comm-bus-telegram` in Claude
Code, the runtime reads the marketplace manifest, resolves the
git-subdir reference, fetches `plugins/claude/telegram/` from the
source monorepo at the pinned tag, and copies the contents into
`~/.claude/plugins/agents-comm-bus-telegram/`.

### Why this shape (Option A)

1. **Atomic releases.** Source change + matching built artifact in one
   commit. Single coherent state. Reverts go back together.
2. **Single source of truth.** Git log on `claude/telegram/` is the
   authoritative history for what was shipped.
3. **Thin marketplace repos** — only manifest files; they only change
   when a new comm joins the family or when bumping the pinned tag.
4. **Simpler CI.** Build → commit to monorepo → tag → optionally bump
   the marketplace manifest's pinned tag. No cross-repo orchestration
   for the artifacts themselves.
5. **Artifact-diff review is occasionally useful** — a noticeable
   bundle-size change from a small source edit catches esbuild output
   drift or unexpected dep version bumps.

### Why two marketplace repos (not one consolidated repo)

A naive consolidation would put both manifests in the same marketplace
repo. **This collides because Codex reads BOTH
`.agents/plugins/marketplace.json` AND
`.claude-plugin/marketplace.json` from any marketplace root** (the
latter as a documented legacy path). If both manifests share one repo,
Codex pulls a doubled listing — its own plugins from `.agents/plugins/`
plus the Claude-flavored plugins from `.claude-plugin/` via the legacy
fallback. Users would see two `agents-comm-bus-telegram` entries.
Claude Code's side is fine either way (it only reads `.claude-plugin/`),
but Codex's dual-read forces the split.

### Option B — fallback for any agent without git-subdir support

If a future agent's marketplace manifest format **does not** support
git-subdir references, the fallback for that one agent is to host its
built plugin files directly inside its marketplace repo (the shape
documented in earlier drafts of this section). The source monorepo
still builds and commits artifacts to `claude/`/`codex/` etc.; CI for
the git-subdir-impaired agent additionally copies the artifacts into
that agent's marketplace repo on each release.

This is per-agent fallback only; agents that do support git-subdir
(Claude Code and Codex both confirmed) keep the Option A shape.

### Ecosystem convergence note

Codex's `.agents/plugins/marketplace.json` is an agent-agnostic
convention. If a future agent adopts the same path with the same shape,
its marketplace could be served from the same
`agents-comm-bus-codex` repo (likely renamed to drop the agent-specific
suffix). Worth re-evaluating once a third agent appears.

## Build matrix and release flow

CI in the source monorepo runs a build matrix:

```
matrix = {claude, codex} × {telegram, matrix, discord, slack}  =  8 plugin artifacts
```

For each `(agent, comm)` combination, CI:

1. Pulls `core/`, `adapters/<comm>/`, `hosts/<agent>/` into a working
   directory.
2. esbuilds `core/` → `daemon.bundle.js` and `adapters/<comm>/` →
   `<comm>.adapter.bundle.js`.
3. Copies `hosts/<agent>/<agent>-mcp-shim.js` and the install hook to
   the agent's expected location:
   - Claude: `claude-install-hook.js` at the plugin root.
   - Codex: `hooks/codex-install-hook.js` per Codex's plugin layout
     convention.
4. Generates the agent-specific plugin manifest at the agent's
   expected path:
   - Claude: `.claude-plugin/plugin.json` (declares MCP server, hooks,
     skill inline).
   - Codex: `.codex-plugin/plugin.json` (manifest) + `.mcp.json`
     (MCP-server declaration; separate file per Codex spec).
5. Copies the agent-specific skill from `hosts/<agent>/skills/<comm>.md`
   to `skills/<comm>.md` in the plugin tree.
6. Writes the resulting directory tree to `plugins/<agent>/<comm>/` in
   the monorepo.
7. Commits the artifact tree on a separate "build:" commit after the
   feature PR merges (see PR-noise mitigation below).
8. Tags the monorepo release with the new version.
9. Updates each marketplace repo's manifest to bump the pinned git
   tag in the corresponding plugin entries.

**Daemon and adapter bundles are byte-identical across `claude/<comm>/`
and `codex/<comm>/`** for a given release — they come from the same
build step, just copied into each agent's tree.

Combinations that aren't supported in v1 (e.g., Codex+Discord may be
deferred) get gated by a flag in CI rather than coded out of the
matrix.

### PR-noise mitigation

Built artifacts in the monorepo create two friction points that need
explicit mitigation:

1. **`.gitattributes` marks `*.bundle.js` as binary** so `git diff`
   doesn't try to render line-level diffs of esbuilt JavaScript output.
   Reviewers see "binary file changed" instead of a wall of minified
   code.
2. **CI commits artifacts in a separate post-merge commit**, not as
   part of the feature PR. The feature PR contains source changes
   only and is reviewed on source. After merge, CI runs the build
   matrix and commits the resulting `<agent>/<comm>/` updates on a
   follow-up commit titled e.g. `build: artifacts for #<PR-number>`.
   The artifact commit is auditable but stays out of the source
   review loop.

### Repo-size considerations

Per release, the artifact dirs grow by ~3 MB (daemon bundle) +
~few hundred KB (adapter bundle) × 8 plugin variants. Over an estimated
50 releases: ~1–2 GB lifetime growth, before git delta compression. Git
delta compression cuts that significantly for the daemon bundle (small
deltas between releases). Shallow clones (`--depth=N`) work for users
who only want HEAD.

If the monorepo's history becomes unwieldy in years, options include
git-LFS migration for `*.bundle.js`, or moving to Option B for all
agents. Not a v1 concern.

## Install lifecycle

### Cold install (first comm plugin on this machine)

1. User runs `/plugin install agents-comm-bus-<comm>`. The host agent's
   plugin runtime fetches the plugin's subdirectory from the
   marketplace repo and extracts it into the host's plugin install path
   (`~/.claude/plugins/agents-comm-bus-<comm>/` or the Codex
   equivalent). Registers MCP server, install hook, skill.
2. User sends any prompt. `install-hook.js` fires:
   1. Checks `~/.agents-comm-bus/bin/daemon.js` — missing.
   2. Creates `~/.agents-comm-bus/`, copies the plugin's
      `daemon.bundle.js` → `bin/daemon.js`, writes `bin/version.json`
      with `installed_by` containing this agent's entry.
   3. Copies the plugin's `<comm>.adapter.bundle.js` → `adapters/<comm>.js`,
      writes `adapters/<comm>.version.json` with this agent's entry.
   4. Spawns daemon detached (`Start-Process` on Windows, `nohup` on
      Unix).
   5. Polls `~/.agents-comm-bus/port` until present, opens the WS
      control connection — this socket is the session lease per v4
      invariant.
3. Daemon startup: opens/migrates `agents-comm-bus.db`, loads
   `adapters/*.js`, reads empty `account_registrations`, idles.
4. Hook injects a first-run hint pointing the user at the plugin's
   setup skill.

### Warm install (second comm plugin OR same comm plugin on a second agent)

1. User runs `/plugin install agents-comm-bus-<other-comm>` (or the
   same `<comm>` from the second agent's marketplace).
2. First prompt after install: that plugin's `install-hook.js` fires:
   1. Reads `~/.agents-comm-bus/bin/version.json` — daemon present.
      Compares versions; upgrades `bin/daemon.js` if the plugin's
      bundle is newer (see below). Adds this hook's agent entry to
      `installed_by` (or updates the existing entry).
   2. Reads `~/.agents-comm-bus/adapters/<comm>.version.json` —
      missing or older plugin_version → copies the plugin's adapter,
      updates `installed_by`.
   3. Sends a `reload-adapters` control message to the daemon over the
      existing WS. **[TBD: v1 may simplify to "next daemon restart"
      and skip hot-reload.]**
   4. Daemon acks: adapter loaded, ready to accept registrations.

### Daemon version reconciliation

- Each plugin ships its own `daemon.bundle.js`. They are built from the
  same monorepo, but releases drift —
  `agents-comm-bus-telegram@1.0` may ship daemon@1, and
  `agents-comm-bus-matrix@1.2` may ship daemon@2.
- The install hook compares `plugin's daemon.bundle.js` plugin_version
  vs the highest `plugin_version` already in `bin/version.json`.
  **Highest wins.**
- The **running** daemon does not hot-swap its own binary. It picks up
  a newer `bin/daemon.js` on next restart. **[TBD: trigger choice —
  "next idle period," "next session start," or explicit
  `/comm restart`.]**

### Adapter hot-reload vs daemon restart

- Adapter add / upgrade: hot-reload via WS control message. Cheap —
  adapters are loadable modules, no in-flight connection disruption for
  *other* adapters. **[TBD: implement in v1 or defer.]**
- Daemon upgrade: restart required. In-flight long-poll connections
  drop and reconnect.

## Migration from `claude-code-telegram`

1. User uninstalls the old `claude-code-telegram` plugin.
2. User installs `agents-comm-bus-telegram` from the Claude marketplace.
3. First prompt bootstraps the daemon and drops the Telegram adapter
   (cold-install lifecycle above).
4. User re-runs registration with their existing bot token:
   `/comm-register telegram <token>` (or via the conversational
   `register_account` MCP tool).
5. Daemon calls Telegram `getMe()`, inserts the
   `account_registrations` row keyed by `(comm='telegram', bot_user_id)`,
   spawns the TelegramAdapter, opens long-poll.

**[TBD: transition-release behavior]** — should the install hook
auto-detect existing `~/.claude-telegram/` directories and offer to
import credentials? Probably yes for the migration window; cleanly
removable after.

## Multi-agent on the same machine

When both Claude Code and Codex have an `agents-comm-bus-<comm>` plugin
installed:

- Both plugins drop their `daemon.bundle.js` and `<comm>.adapter.bundle.js`
  copies into `~/.claude/plugins/...` and `~/.codex/plugins/...`
  respectively (separate plugin install paths per agent).
- Both install hooks bootstrap into the same shared
  `~/.agents-comm-bus/` location. Reference counting deduplicates and
  tracks ownership.
- At runtime each agent's MCP shim opens its own WS control connection
  to the **single** daemon. The daemon distinguishes them via the
  AgentAdapter identify handshake (`agent='claude'` vs
  `agent='codex'`), stored in the `sessions` row tied to that
  connection.
- `account_registrations` is keyed on `(project, comm, agent, account_label)`
  with `UNIQUE(comm, bot_user_id)` enforced — each agent has its own
  registrations, but no two registrations can race the same comm-side
  bot identity.

## Duplicate-invocation safety

When N comm plugins are installed for the same agent (e.g., `agents-comm-bus-telegram`,
`agents-comm-bus-matrix`, `agents-comm-bus-discord` all on Claude
Code), the agent's plugin runtime invokes each plugin's install hook
and runs each plugin's MCP server independently. Without explicit
idempotency this would mean N parallel daemon-bootstrap attempts, N WS
connections per session, N copies of pending messages reaching the
prompt context, and possibly N MCP server processes serving identical
tools.

Each failure mode has a specific mitigation. The unifying principle:
**all roads lead to the daemon; the daemon is the only stateful
place.** Hooks and MCP shims are stateless and idempotent.

### 1. Bootstrap coordination

A lockfile at `~/.agents-comm-bus/bootstrap.lock`, created with
`O_CREAT|O_EXCL`, serializes the daemon-spawn path:

- Multiple hooks fire in parallel; only the first to grab the lock
  performs the daemon spawn + adapter copies.
- Other hooks poll for `~/.agents-comm-bus/port` to appear, then
  connect normally.
- Lock is released when bootstrap completes, or expires via lockfile
  timestamp + timeout (in case of crash mid-bootstrap).

### 2. Session-deduplication on WS handshake

Without dedupe, N hooks firing means N WS connections for the same
agent session — which would violate the v4
*connection-lifetime-IS-session-lease* invariant by minting N
sessions.

Mitigation: the WS handshake carries a `session_key` derived from
`(agent, project, top-level-process-pid)`. The daemon recognizes
"this session already has a primary connection" and accepts subsequent
connections as **redundant** — they receive a `not-primary` ack and
close gracefully. Only the primary carries the session lease and
receives wake signals.

Granularity of the `top-level-process-pid` is **[TBD]** — needs to
survive subagent spawns within one session. Probably the
process-tree-root that owns the visible terminal/console.

### 3. Idempotent message delivery

After bootstrap, hooks ask the daemon "any pending messages for my
session?" The daemon tracks `sessions.last_delivered_message_id` and
marks messages delivered atomically when serving the query. Redundant
calls after the first return empty — so even if N hooks all ask, only
one batch of messages reaches the prompt context. No N-way
duplication of user-visible content.

### 4. MCP server registration

This is the layer that depends on each agent's plugin runtime
behavior, and is **[TBD]** pending verification:

When N plugins each declare an MCP server named `agents-comm-bus`
in their `.claude-plugin/plugin.json` (Claude) or `.mcp.json` (Codex),
does the agent's plugin runtime:

- (a) Dedupe by name and spawn one server process,
- (b) Spawn N independent processes,
- (c) Reject duplicate registrations?

Outcome (a) is what we want. If (b), the safety design relies on the
MCP shim being a **stateless RPC forwarder** to the daemon —
concurrent shim instances all forwarding to the same daemon are fine
because the daemon serializes. If (c), declarations would need to be
conditional, which is fragile (uninstalling the "primary" plugin
would deregister the shim for everyone).

The shim **MUST** be designed for outcome (b) regardless, because (a)
is convenient but cannot be assumed across agents. Concrete design
implications:

- The MCP shim holds no per-tool-call state. Each call is a fresh
  request → daemon → response cycle.
- Tools are named at a granularity that doesn't depend on which
  comm plugin shipped the shim (e.g., `register_account` with
  `comm` as a parameter, not `register_telegram_account` as a
  separate tool per comm).
- The daemon — not the shim — is the source of truth for what
  comms are registered. The shim's tool list is identical across
  plugins regardless of which comm plugin it came from.

### Worst-case posture

Even if no agent runtime dedupes hooks or MCP servers — and if the
session-key heuristic fails to coalesce concurrent connections — the
model still ships safe because the daemon is the only stateful
component. Adversarial duplicate invocations cost a few microseconds
of redundant checks. The user-visible behavior is unchanged.

## Implications for the broader v4 plan

- **v4 invariant #8 preserved** — "daemon state must never live under
  plugin install paths" still holds. `~/.agents-comm-bus/` is the
  state root; `~/.claude/plugins/agents-comm-bus-<comm>/` and the
  Codex equivalent hold code artifacts only.
- **v4 invariant #10 preserved** — old layouts
  (`~/.claude-telegram/`, `~/.codex-telegram/`) are readable during
  the transition release.
- **The plan's "daemon shipped inside each plugin"** language still
  applies — it just means "inside each peer-class comm plugin," not
  "inside the agents-comm-bus core plugin."
- **Single ownership of `(comm, bot_user_id)`** is unaffected. The
  registration table's `UNIQUE` constraint runs the same way whether
  the registration came from the Telegram plugin or the Matrix plugin
  or from Claude or from Codex.

## Open design questions

1. **Adapter hot-reload** — implement in v1 via WS control message, or
   defer to "next daemon restart"?
2. **Daemon upgrade trigger** — when does the running daemon respect a
   newer `bin/daemon.js` on disk? Candidates: next idle period, next
   session start, explicit `/comm restart`.
3. **Plugin uninstall cleanup** — should
   `/plugin uninstall agents-comm-bus-matrix` drop
   `~/.agents-comm-bus/adapters/matrix.js` and the related
   `account_registrations` rows? Default behavior probably removes
   only this agent's entry from `installed_by` and leaves the file in
   place until the list is empty; a confirm prompt could offer
   teardown.
4. **First-run discovery for related comms** — once a user has one
   comm plugin installed, how do they learn about the others? Skill
   hint on first use ("want Matrix too? `/plugin install
   agents-comm-bus-matrix`"), marketplace family grouping, or both.
5. **Marketplace family discoverability** — naming prefix
   (`agents-comm-bus-*`) helps but doesn't beat real package grouping.
   Worth a documentation hub describing the family + each plugin's
   description prominently linking the rest.
6. **Transition-release credentials import** — should the Telegram
   plugin's install hook detect `~/.claude-telegram/` and offer to
   import? Recommended yes for the migration window.
7. **Wake mechanism when no agent session is running** but an inbound
   message arrives — file trigger, OS notification, or "wait until
   next session start." Inherited from the existing watcher design;
   resolution may not be specific to the install model.
8. **Build matrix v1 cutoff** — which `(agent, comm)` combinations are
   supported at v1 launch? Telegram is mandatory for both Claude and
   Codex (migration anchor). Matrix on Claude is a natural early
   target. Other combinations gated by a CI flag.
9. **Cross-agent marketplace convergence** — if Codex's
   `.agents/plugins/` convention proves to be the de facto standard,
   should the codex marketplace repo be renamed/restructured to host
   *all* agents that adopt it, with Claude as the sole legacy
   exception? Premature now; revisit when a third agent appears.
10. **MCP-server-name dedupe by host runtime** — does Claude Code
    dedupe MCP server entries with the same name across multiple
    plugin manifests? Does Codex dedupe `.mcp.json` entries across
    plugins? Affects whether the stateless-RPC-forwarder design is
    needed in v1 or is just a defense-in-depth precaution
    (see *Duplicate-invocation safety*).
11. **Session-key derivation granularity** — what process ancestor
    serves as the stable session_key for WS-handshake dedupe? Must
    survive subagent spawns within one session without minting new
    sessions, and must NOT collapse two unrelated terminal sessions
    into one.

## Related docs

- [`dist-tree-plan.md`](./dist-tree-plan.md) — canonical directory
  sketch of the source monorepo + the two marketplace repos. This
  doc is the prose elaboration of that sketch.
- [`../architecture/invariants.md`](../architecture/invariants.md) —
  runtime contracts the install model preserves.
- [`../architecture/storage-layout.md`](../architecture/storage-layout.md)
  — what the daemon writes into the state subtrees.
- [`../architecture/sequence-daemon-bootstrap.md`](../architecture/sequence-daemon-bootstrap.md)
  — adjacent sequence diagram for daemon startup, complementary to the
  install lifecycle above.
- [`matrix-setup-guide.md`](./matrix-setup-guide.md) — the kind of
  user-facing walkthrough each comm plugin's skill will reference.
