// AGE-23: esbuild the daemon entry (core-daemon/serve.ts) into a single
// self-contained ESM bundle that inlines its workspace package
// (agents-comm-bus-core) and external runtime deps (ws, node-telegram-bot-api),
// so the production marketplace install can ship/copy ONE portable daemon
// (~/.agents-comm-bus/bin/daemon.js) instead of a raw tsc dist tree that can't
// resolve its imports. Mirrors the mcp-shim esbuild recipe in hosts/package.json
// (createRequire banner for the CJS deps).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, copyFile } from "node:fs/promises";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, ".."); // agents-comm-bus/
const repoRoot = path.resolve(pkgRoot, ".."); // repo root (holds core-daemon/, adapters/)

const outDir = path.join(pkgRoot, "dist-bundle");
const outfile = path.join(outDir, "daemon.bundle.js");
const schemaSrcDir = path.join(repoRoot, "core-daemon", "storage", "schema");
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [path.join(repoRoot, "core-daemon", "serve.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile,
  // node:* builtins (incl. node:sqlite) are externalized automatically for
  // platform=node. The CJS deps (node-telegram-bot-api, ws transitively) need a
  // require() shim under ESM output.
  banner: {
    js: "import { createRequire as __acbCreateRequire } from 'module'; const require = __acbCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

// Colocate the migration .sql next to the bundle: in the bundled output,
// runner.ts's `import.meta.url` resolves to THIS file, so it reads schema from
// the bundle's own directory. Shipping them together keeps the daemon artifact
// runnable wherever it is copied (e.g. ~/.agents-comm-bus/bin/).
const sqlFiles = (await readdir(schemaSrcDir)).filter((f) => f.endsWith(".sql"));
for (const f of sqlFiles) {
  await copyFile(path.join(schemaSrcDir, f), path.join(outDir, f));
}

console.log(
  `[build-daemon-bundle] wrote ${path.relative(repoRoot, outfile)} + ${sqlFiles.length} schema .sql`,
);
