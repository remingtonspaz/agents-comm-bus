# Decision #2 — shared core package: keep separate vs fold

**Status:** decided — keep separate package boundary
**Date:** 2026-05-23
**Scope:** final home for the current `agents-comm-bus-core/**` package during the restructure

## Recommendation snapshot

### Chosen direction
**Keep the package boundary and move `agents-comm-bus-core/` to `packages/core-contracts/`, while renaming the daemon runtime tree to `core-daemon/`.**

Why this is the safest default:
- preserves the current Node package boundary and `exports` surface
- preserves the one-way dependency guard (`daemon runtime -> shared contracts`, not vice versa)
- avoids the daemon-vs-shared naming collision by using `core-daemon/` and `packages/core-contracts/`
- minimizes migration risk and import churn
- keeps future standalone publishability available if Level 3 modularization ever becomes relevant

### Acceptable alternative
**Fold the package into the daemon runtime tree under `core-daemon/domain/`, but only if the same PR also ships an architecture test guarding the boundary.**

Rule:
- **No guard, no fold.**

### Naming conclusion
- **Do not use `core/invariants/`.** The contents are broader than invariants.
- Preferred names:
  - if kept separate: `packages/core-contracts/` with daemon runtime at `core-daemon/`
  - if folded: `core-daemon/domain/`

---

## What exists today

The current `agents-comm-bus-core/` package contains more than a narrow "invariants" layer. Its source tree currently includes:

- `types.ts`
- `messages.ts`
- `queries.ts`
- `capabilities.ts`
- `security.ts`
- `query-semantics.ts`
- `contracts/**`
- `records/**`
- `storage/**`

It is also a real Node package today:
- has its own `package.json`
- has explicit `exports`
- has its own `tsconfig.json`
- builds `src/** -> dist/**`

The repo currently contains many imports against that boundary:
- source imports from `agents-comm-bus-core/dist/...`
- tests import directly from `agents-comm-bus-core/src/...`

So this decision is **not** just a folder rename. It is also a packaging and dependency-boundary decision.

---

## Option A — keep separate package

### Proposed location

```text
packages/
└── core-contracts/
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── index.ts
    │   ├── types.ts
    │   ├── messages.ts
    │   ├── queries.ts
    │   ├── capabilities.ts
    │   ├── security.ts
    │   ├── query-semantics.ts
    │   ├── contracts/
    │   ├── records/
    │   └── storage/
    └── dist/
```

### Directory shape after restructure

```text
agents-comm-bus/
├── core-daemon/                  daemon runtime
│   ├── daemon.ts
│   ├── bus.ts
│   ├── serve.ts
│   ├── bridges/
│   ├── runtime/
│   ├── ipc/
│   ├── bootstrap/
│   ├── storage/
│   └── migrations/
├── packages/
│   └── core-contracts/           shared contracts/types/domain package
├── adapters/
│   └── <comm>/
├── hosts/
│   ├── <agent>/
│   └── common/
└── plugins/
```

### Import shape

There are two reasonable forms.

#### A1. Preserve package-name imports
Preferred if workspace/package-manager wiring is added:

```ts
import type { Storage } from "agents-comm-bus-core/storage/storage";
import { SCHEMA_VERSION_QUERY } from "agents-comm-bus-core";
```

This keeps the source intent clearest, but may require updating the package name or workspace mapping depending on the final monorepo setup.

#### A2. Use local monorepo-relative imports
Lowest tooling surprise during transition:

```ts
import type { Storage } from "../packages/core-contracts/dist/storage/storage.js";
import { SCHEMA_VERSION_QUERY } from "../packages/core-contracts/dist/index.js";
```

This is mechanically straightforward but less elegant. It still preserves the package boundary on disk/build.

### Pros

- preserves hard package boundary
- preserves explicit `exports`
- preserves future standalone-publish option
- keeps `core-daemon/` unambiguously meaning **daemon runtime only**
- lowest conceptual risk during restructure

### Cons

- still two TS build units unless later consolidated under project references/workspaces

### Recommended when

Choose this path if the priority is:
- lowest risk
- clearest long-term boundaries
- minimal architectural ambiguity

---

## Option B — fold into daemon tree

### Proposed location

```text
core-daemon/
├── domain/
│   ├── index.ts
│   ├── types.ts
│   ├── messages.ts
│   ├── queries.ts
│   ├── capabilities.ts
│   ├── security.ts
│   ├── query-semantics.ts
│   ├── contracts/
│   ├── records/
│   └── storage/
├── bridges/
├── runtime/
├── ipc/
├── bootstrap/
├── storage/
├── daemon.ts
├── bus.ts
└── serve.ts
```

### Why `core-daemon/domain/`

`core-daemon/domain/` is a better fit than `core/invariants/` because the folded package contains:
- record schemas
- message/query shapes
- storage interfaces
- security rules
- capability declarations
- shared type aliases

Those are broader than invariants, and `domain/` avoids collision/confusion with daemon implementation folders like `core-daemon/storage/`.

### Import shape after fold

Representative examples:

```ts
import type { Storage } from "./domain/storage/storage.js";
import { SCHEMA_VERSION_QUERY } from "./domain/index.js";
```

Tests would similarly move from:

```ts
import { ... } from "../../agents-comm-bus-core/src/index.js";
```

to:

```ts
import { ... } from "../../core-daemon/domain/index.js";
```

### Mechanical migration required

- move `agents-comm-bus-core/src/**` -> `core-daemon/domain/**`
- remove `agents-comm-bus-core/package.json`
- remove `agents-comm-bus-core/tsconfig.json`
- update all source imports from `agents-comm-bus-core/dist/...`
- update all test imports from `agents-comm-bus-core/src/...`
- consolidate the build into the unified daemon TS project

### Pros

- one TS project instead of two
- simpler build pipeline
- fewer package-management moving parts
- easy mental model for contributors who prefer one source tree

### Cons

- package-boundary enforcement is lost unless replaced
- import rewrite blast radius is large
- easier for daemon implementation code to accidentally leak into the shared layer over time
- forecloses easy future standalone packaging unless re-extracted later

### Required guardrail

**This path is only acceptable if the same PR ships an architecture test enforcing the folded boundary.**

---

## Required guard for Option B (fold path)

### Goal

Restore, via tests, the one-way dependency rule currently enforced by the separate package boundary.

### Boundary rule

Files under `core-daemon/domain/**` **must not import from**:
- `core-daemon/daemon.*`
- `core-daemon/bus.*`
- `core-daemon/serve.*`
- `core-daemon/bridges/**`
- daemon implementation folders under `core-daemon/runtime/**`, `core-daemon/ipc/**`, `core-daemon/bootstrap/**`, `core-daemon/storage/**`, `core-daemon/migrations/**`, `core-daemon/cli/**`
- `adapters/**`
- `hosts/**`
- `plugins/**`

`core-daemon/domain/**` may import only from:
- sibling files inside `core-daemon/domain/**`
- Node built-ins
- explicitly approved external libs if needed for pure shared semantics

### Test shape

Create a filesystem-based architecture test, e.g.:

```text
tests/architecture/domain-boundary.test.ts
```

### Test behavior

The test should:
1. walk every `.ts` file under `core-daemon/domain/**`
2. parse import specifiers with a lightweight regex or TS parser
3. resolve relative imports to normalized repo-relative paths
4. fail if any resolved import escapes `core-daemon/domain/**` into forbidden zones
5. allow Node built-ins and approved package imports

### Pseudocode sketch

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { searchFiles, readFileLike } from "./helpers";

describe("core/domain boundary", () => {
  it("does not import daemon runtime or host/adapter code", async () => {
    const files = listTsFiles("core-daemon/domain");

    for (const file of files) {
      const imports = extractImportSpecifiers(file);
      for (const specifier of imports) {
        if (isNodeBuiltin(specifier) || isApprovedExternal(specifier)) continue;
        const resolved = resolveRelativeRepoPath(file, specifier);
        assert.ok(
          resolved.startsWith("core-daemon/domain/"),
          `${file} imports forbidden path ${resolved}`,
        );
      }
    }
  });
});
```

### Acceptance criterion

The fold PR is not complete unless this test exists and passes.

---

## Why not `core/invariants/`

`core/invariants/` has the right "bedrock" tone, but it is too narrow for the actual contents.

What lives there is not just invariants. It includes:
- public type aliases (`AgentId`, `CommId`, etc.)
- message and query shapes
- record schemas
- storage interfaces
- contract interfaces
- capability declarations
- security and query-semantics helpers

So `invariants/` would underspecify the layer and invite future confusion.

---

## Decision matrix

### Pick **Option A — keep separate as `packages/core-contracts/` + `core-daemon/`** if you want:
- lowest migration risk
- preserved package-boundary enforcement
- preserved future publishability
- cleaner semantic separation between daemon runtime and shared contract layer

### Pick **Option B — fold into `core-daemon/domain/`** if you want:
- simpler build pipeline
- fewer packages
- a single source tree
- and you are willing to ship the architecture-boundary guard in the same PR

---

## Recommended call

**Chosen Option A: keep separate and move to `packages/core-contracts/`, with daemon runtime at `core-daemon/`.**

Reason:
- it preserves the strongest architectural boundary at the lowest operational risk
- it keeps `core/` unambiguously meaning daemon runtime
- it does not close off later folding if experience shows the extra package is more burden than value

**Option B remains acceptable** if the user explicitly prefers the simpler build pipeline and agrees that the fold PR must include the boundary test.

---

## Follow-up after decision

Once the user picks:
1. update `docs/research/install-model.md`
2. update `docs/research/dist-tree-plan.md`
3. update `docs/architecture/proposals/2026-05-23-restructure-paths.md`
4. then execute the mechanical path move / import rewrite consistent with the chosen branch
