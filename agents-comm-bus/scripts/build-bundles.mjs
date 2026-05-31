// AGE-23: esbuild every host runtime surface into self-contained ESM bundles so
// a fresh marketplace install runs in PRODUCTION mode without a node_modules
// tree or the raw tsc dist. Each bundle inlines its workspace package
// (agents-comm-bus-core) and external runtime deps (ws, node-telegram-bot-api).
//
// Emitted into agents-comm-bus/dist-bundle/ (gitignored; stage-plugins copies
// the relevant artifacts into the tracked plugins/<agent>/<comm>/ trees):
//
//   daemon.bundle.js              <- core-daemon/serve.ts   (spawned as bin/daemon.js;
//                                    comm-neutral, loads adapters/*.js dynamically)
//   <NNN>_*.sql                   <- migration schema, colocated next to the bundle
//   telegram.adapter.bundle.js    <- adapters/telegram/factory.ts (central adapter copy)
//   cli.bundle.js                 <- core-daemon/cli/index.ts (admin CLI surface)
//   hooks/<agent>/<hook>.js       <- hosts/<agent>/hooks/<hook>.js (self-contained)
//
// Mirrors the mcp-shim esbuild recipe in hosts/package.json (createRequire
// banner so inlined CJS deps can call require under ESM output).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, copyFile } from "node:fs/promises";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, ".."); // agents-comm-bus/
const repoRoot = path.resolve(pkgRoot, ".."); // repo root (holds core-daemon/, adapters/, hosts/)

const outDir = path.join(pkgRoot, "dist-bundle");
const schemaSrcDir = path.join(repoRoot, "core-daemon", "storage", "schema");

// createRequire banner: inlined CJS deps (node-telegram-bot-api, and ws's
// transitive requires) call require() at runtime under ESM output.
const BANNER = {
  js: "import { createRequire as __acbCreateRequire } from 'module'; const require = __acbCreateRequire(import.meta.url);",
};

const COMMON = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: BANNER,
  logLevel: "info",
};

/** Bundle one entry to one outfile. */
async function bundleOne(entryRel, outRel) {
  await build({
    ...COMMON,
    entryPoints: [path.join(repoRoot, entryRel)],
    outfile: path.join(outDir, outRel),
  });
}

await mkdir(outDir, { recursive: true });

// 1. Daemon — comm-neutral composition root. Comm adapters are loaded from the
//    central adapters dir at runtime, so Telegram stays in telegram.adapter.bundle.js.
await bundleOne(path.join("core-daemon", "serve.ts"), "daemon.bundle.js");

// 1b. Colocate the migration .sql next to the bundle. In the bundled output the
//     runner's import.meta.url resolves to the bundle file, so it reads schema
//     from the bundle's own directory. The install hook copies these alongside
//     daemon.bundle.js -> bin/ (see daemon_sidecars in the install stamp).
const sqlFiles = (await readdir(schemaSrcDir)).filter((f) => f.endsWith(".sql"));
for (const f of sqlFiles) {
  await copyFile(path.join(schemaSrcDir, f), path.join(outDir, f));
}

// 2. Per-comm CommAdapter — the central adapters/<comm>.js copy loaded
//    dynamically by the comm-agnostic daemon.
await bundleOne(path.join("adapters", "telegram", "factory.ts"), "telegram.adapter.bundle.js");

// 3. Admin CLI surface (account-add / allowlist / migrate ...). Shipped so a
//    marketplace install can run it without a dist tree or npm link.
await bundleOne(path.join("core-daemon", "cli", "index.ts"), "cli.bundle.js");

// 4. Host hooks — each declared hook entry, self-contained so a fresh clone /
//    staged plugin loads them without the daemon dist on disk. Helpers they
//    import (e.g. wake-support.js) are inlined.
const HOOKS = {
  claude: ["user-prompt-submit.js", "permission-request.js", "session-start.js"],
  codex: ["user-prompt-submit.js", "permission-request.js", "session-start.js"],
};
let hookCount = 0;
for (const [agent, files] of Object.entries(HOOKS)) {
  for (const file of files) {
    await bundleOne(
      path.join("hosts", agent, "hooks", file),
      path.join("hooks", agent, file),
    );
    hookCount += 1;
  }
}

console.log(
  `[build-bundles] daemon + ${sqlFiles.length} schema .sql + telegram adapter + cli + ${hookCount} hooks -> ${path.relative(repoRoot, outDir)}`,
);
