# Skill Assembly — Source-to-Artifact Mapping

## Purpose

This document defines the skill assembly contract used to generate per-`(agent, comm)` `SKILL.md` artifacts from source-side editorial inputs. The assembly is **frontmatter-aware**: each shipped artifact contains exactly one `name` and one `description` block, not concatenated frontmatter from multiple input files.

## Source layout

```
hosts/
  common/
    skills/
      fragments/
        <comm>/                 — shared body fragments (no frontmatter)
          shared-body.md
          prepend-*.md          — inserted before agent-specific body
          *.md                  — appended after agent-specific body
  <agent>/
    skills/
      <comm>/
        SKILL.md              — agent-specific entrypoint (frontmatter + body)
  fixtures/
    <fixture-name>/
      SKILL.md              — fixture for pipeline testing
```

## Artifact layout

```
plugins/
  <agent>/
    <comm>/
      .<agent>-plugin/
        plugin.json            — generated manifest with local paths only
      .mcp.json                — Codex-only MCP server config
      skills/
        <comm>/
          SKILL.md             — assembled frontmatter-aware output
```

## Assembly script

`scripts/assemble-skills.js` discovers `(agent, comm)` pairs under `hosts/<agent>/skills/<comm>/`, then for each pair:

1. **Parses** the agent-specific `SKILL.md` to extract its single frontmatter block.
2. **Validates** that frontmatter contains exactly one `name:` and one `description:`.
3. **Reads** shared fragments from `hosts/common/skills/fragments/<comm>/` in deterministic alphabetical order.
4. **Strips** any frontmatter found in fragment files (only the agent-specific source provides canonical frontmatter).
5. **Assembles** output as:
   ```
   ---
   <frontmatter from agent-specific source>
   ---

   <prepend fragments>

   <agent-specific body>

   <append fragments>
   ```
6. **Writes** the artifact to `plugins/<agent>/<comm>/skills/<comm>/SKILL.md`.

## Determinism guarantees

- Fragments are processed in **alphabetical** filename order.
- `prepend-*` fragments are ordered before non-`prepend` fragments.
- The script exits with non-zero if any source is missing a frontmatter block, or if validation fails.
- Running `node scripts/assemble-skills.js --verify` compares staged artifacts against fresh assembly output without overwriting.

## Fixture

`hosts/fixtures/test-skill/` is a stable fixture used by the artifact-tree tests to verify assembly behavior without depending on final editorial prose for Telegram.

## Build integration

Run the assembly via npm:
```
npm run assemble:skills
```
