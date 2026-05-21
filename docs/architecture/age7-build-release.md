# AGE-7 build, tag, and marketplace pointer flow

This repository now carries the AGE-7 distribution plumbing for the full 2 x 4 matrix:

- Agents: `claude`, `codex`
- Comms: `telegram`, `matrix`, `discord`, `slack`

Generated payloads land under `plugins/<agent>/<comm>/`.

## What is generated

Each plugin payload contains:

- `daemon.bundle.js`
- `<comm>.adapter.bundle.js`
- host-native manifest files
- reusable hook payloads
- `skills/<comm>.md`
- SQLite schema files needed by the bundled daemon

Telegram is the only fully implemented comm in the current source tree. Matrix, Discord, and Slack are scaffold payloads so CI and release automation exercise the whole marketplace layout without claiming those adapters are production-ready.

## Build the plugin matrix

From the repo root:

```bash
npm run build:plugins
```

That command:

1. builds `agents-comm-bus-core`, `agents-comm-bus`, and `mcp-server`
2. bundles the daemon and Telegram adapter
3. writes scaffold bundles for comms that do not have runtime code yet
4. regenerates `plugins/claude/*` and `plugins/codex/*`

## CI

GitHub Actions workflow: `.github/workflows/age7-build-release.yml`

The workflow installs dependencies, builds the plugin matrix, and runs the distribution tests in `tests/distribution/`.

## Post-merge artifact commit strategy

AGE-7 keeps build output auditable without polluting source-review diffs:

1. merge the source PR first
2. run `npm run build:plugins`
3. commit only generated artifacts and release plumbing with a message like:
   `build: plugin artifacts for <merge-sha>`
4. verify the worktree is clean
5. run the tag gate:

```bash
npm run release:check -- --tag v2.0.0
```

The tag gate checks:

- tag matches `package.json` version
- git worktree is clean
- generated plugin artifacts exist for every matrix entry
- the requested tag is not already present

## Marketplace pointer repos

The source monorepo stays separate from the marketplace pointer repos.

- Claude pointer repo target file: `.claude-plugin/marketplace.json`
- Codex pointer repo target file: `.agents/plugins/marketplace.json`

Do not place both manifests in the same repo root. Codex reads both locations and can surface duplicate listings if the repos are consolidated.

To update a pointer repo after tagging:

```bash
node scripts/update-marketplace-pointers.js \
  --agent claude \
  --repo /absolute/path/to/agents-comm-bus-claude \
  --tag v2.0.0

node scripts/update-marketplace-pointers.js \
  --agent codex \
  --repo /absolute/path/to/agents-comm-bus-codex \
  --tag v2.0.0
```

The script refuses to write a Claude manifest into a repo that already contains the Codex manifest path, and vice versa.

## Distribution tests

Run locally with:

```bash
npm run test:distribution
```

Current checks cover:

- required files exist for every `plugins/<agent>/<comm>/` entry
- scaffold vs implemented status is explicit in the generated skills
- marketplace manifests point to the correct monorepo subtrees
- mixed-agent marketplace roots are rejected to avoid duplicate Codex listings
