import assert from "node:assert/strict";
import { execFile, execFileSync, exec } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import {
  PI_COMMS,
  PER_COMM_VERSION,
  PI_CORE_VERSION,
  TELEGRAM_PRODUCTION_POSTINSTALL,
  buildCoreReleaseTree,
  buildPerCommReleaseTree,
  coreFileGitDependency,
  coreGitDependency,
  diffReleaseTree,
  formatMismatches,
  listDestinationFiles,
  runCorePostinstall,
  syncAllReleases,
  syncCoreRelease,
  syncPerCommRelease,
  validateCoreRef,
  verifyAllReleases,
} from "../../scripts/lib/sync-pi-release.mjs";
import {
  parseSyncPiReleaseArgs,
  runSyncPiReleaseCli,
} from "../../scripts/sync-pi-release-repos.mjs";

const run = promisify(execFile);
const runShell = promisify(exec);
const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const agentsCommBusDir = path.join(monorepoRoot, "agents-comm-bus");
const syncCliPath = path.join(monorepoRoot, "scripts", "sync-pi-release-repos.mjs");
const FAKE_CORE_REF = "a".repeat(40);

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function linkWorkspacePackage(layout: string, name: string): Promise<void> {
  // These are Pi peer dependencies, deliberately supplied from this checkout.
  // This proves the release package boundary with the monorepo's current peer
  // versions; it does not claim compatibility with every consumer peer version.
  const src = path.join(monorepoRoot, "node_modules", name);
  if (!existsSync(src)) {
    throw new Error(`missing workspace dependency ${name} (run npm install in monorepo)`);
  }
  const dest = path.join(layout, "node_modules", name);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

function initGitRepo(repoDir: string): void {
  execFileSync("git", ["init"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "age88-probe@test"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "age88-probe"], { cwd: repoDir });
}

function gitCommitAll(repoDir: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", message], { cwd: repoDir });
}

async function copyTreeForFixture(src: string, dest: string): Promise<void> {
  await cp(src, dest, {
    recursive: true,
    filter: (srcPath) => !srcPath.includes(`${path.sep}.git${path.sep}`) && !srcPath.endsWith(`${path.sep}.git`),
  });
}

async function createTempCommittedCoreRepo(): Promise<{ coreRepo: string; coreSha: string }> {
  const coreRepo = await tempDir("acb-age88-temp-core-repo-");
  await syncCoreRelease({
    monorepoRoot,
    destRoot: coreRepo,
    removeStale: true,
    enumeration: "filesystem",
  });
  initGitRepo(coreRepo);
  gitCommitAll(coreRepo, "AGE-88 temp pi-core probe");
  const coreSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: coreRepo }).toString("utf8").trim();
  validateCoreRef(coreSha);
  return { coreRepo, coreSha };
}

async function spawnSyncCli(args: string[], cwd = monorepoRoot): Promise<{ code: number; stderr: string }> {
  try {
    const { stderr } = await run(process.execPath, [syncCliPath, ...args], { cwd });
    return { code: 0, stderr: stderr ?? "" };
  } catch (error) {
    const err = error as { code?: number; stderr?: string };
    return { code: err.code ?? 1, stderr: err.stderr ?? "" };
  }
}

describe("AGE-88 Pi release sync guard", () => {
  it("rejects malformed core refs", () => {
    assert.throws(() => validateCoreRef("abc"), /--core-ref must be a 40-character/);
    assert.throws(() => validateCoreRef("g".repeat(40)), /--core-ref must be a 40-character/);
    assert.doesNotThrow(() => validateCoreRef(FAKE_CORE_REF));
  });

  it("core output contains AGE-63 skipCentralInstall and AGE-72 label scope registration", () => {
    const tree = buildCoreReleaseTree(monorepoRoot);
    const daemonClient = tree.get("extensions/agents-comm/daemon-client.ts")!.toString("utf8");
    const indexTs = tree.get("extensions/agents-comm/index.ts")!.toString("utf8");

    assert.match(daemonClient, /skipCentralInstall:\s*true/);
    assert.match(indexTs, /account_label_scope:\s*serializeAccountLabelScope/);
    assert.match(indexTs, /from\s+["']agents-comm-bus\/session-label-scope["']/);
    assert.doesNotMatch(indexTs, /core-daemon\/session-label-scope/);
  });

  it("recursive mirror includes novel core and per-comm source files and detects their drift", async () => {
    const fixtureRoot = await tempDir("acb-age88-novel-fixture-");
    await copyTreeForFixture(path.join(monorepoRoot, "plugins", "pi", "core"), path.join(fixtureRoot, "plugins", "pi", "core"));
    await copyTreeForFixture(path.join(monorepoRoot, "plugins", "pi", "curl"), path.join(fixtureRoot, "plugins", "pi", "curl"));
    await copyTreeForFixture(agentsCommBusDir, path.join(fixtureRoot, "agents-comm-bus"));

    const novelCoreRel = "extensions/agents-comm/novel-core-marker.ts";
    const novelCommRel = "novel-per-comm-marker.txt";
    await writeFile(
      path.join(fixtureRoot, "plugins", "pi", "core", novelCoreRel),
      "export const NOVEL_CORE_MARKER = true;\n",
    );
    await writeFile(
      path.join(fixtureRoot, "plugins", "pi", "curl", novelCommRel),
      "novel-per-comm-marker\n",
    );

    const coreTree = buildCoreReleaseTree(fixtureRoot);
    const curlTree = buildPerCommReleaseTree(fixtureRoot, "curl", FAKE_CORE_REF);
    assert.ok(coreTree.has(novelCoreRel), "novel core source must be mirrored");
    assert.ok(curlTree.has(novelCommRel), "novel per-comm source must be mirrored");

    const dest = await tempDir("acb-age88-novel-out-");
    await syncPerCommRelease({
      monorepoRoot: fixtureRoot,
      comm: "curl",
      destRoot: dest,
      coreRef: FAKE_CORE_REF,
      removeStale: true,
      enumeration: "filesystem",
    });
    assert.ok(existsSync(path.join(dest, novelCommRel)));

    await rm(path.join(dest, novelCommRel));
    const mismatches = await diffReleaseTree(curlTree, dest, { enumeration: "filesystem" });
    assert.ok(
      mismatches.some((m) => m.kind === "missing" && m.path === novelCommRel),
      "missing novel per-comm file must fail verify",
    );
  });

  it("git destinations remove only tracked stale files; untracked sentinel and node_modules survive", async () => {
    const repo = await tempDir("acb-age88-git-clean-");
    initGitRepo(repo);

    await syncPerCommRelease({
      monorepoRoot,
      comm: "curl",
      destRoot: repo,
      coreRef: FAKE_CORE_REF,
      removeStale: true,
      enumeration: "git",
    });
    gitCommitAll(repo, "seed curl release");

    await writeFile(path.join(repo, "tracked-stale.txt"), "tracked stale\n");
    gitCommitAll(repo, "add tracked stale");

    await writeFile(path.join(repo, "untracked-sentinel.txt"), "leave me\n");
    mkdirSync(path.join(repo, "node_modules", "local-only"), { recursive: true });
    await writeFile(path.join(repo, "node_modules", "local-only", "sentinel.txt"), "nm\n");

    const expected = buildPerCommReleaseTree(monorepoRoot, "curl", FAKE_CORE_REF);
    let mismatches = await diffReleaseTree(expected, repo, { enumeration: "git" });
    assert.ok(mismatches.some((m) => m.kind === "extra" && m.path === "tracked-stale.txt"));
    assert.ok(!mismatches.some((m) => m.path === "untracked-sentinel.txt"));
    assert.ok(!mismatches.some((m) => m.path.includes("node_modules")));

    await syncPerCommRelease({
      monorepoRoot,
      comm: "curl",
      destRoot: repo,
      coreRef: FAKE_CORE_REF,
      removeStale: true,
      enumeration: "git",
    });
    assert.equal(existsSync(path.join(repo, "tracked-stale.txt")), false);
    assert.equal(existsSync(path.join(repo, "untracked-sentinel.txt")), true);
    assert.equal(existsSync(path.join(repo, "node_modules", "local-only", "sentinel.txt")), true);

    mismatches = await diffReleaseTree(expected, repo, { enumeration: "git" });
    assert.deepEqual(mismatches, [], formatMismatches("git-clean", mismatches));

    const listed = await listDestinationFiles(repo, { enumeration: "git" });
    assert.ok(!listed.includes("untracked-sentinel.txt"));
    assert.ok(!listed.some((p) => p.startsWith("node_modules/")));
  });

  it("vendored agents-comm-bus/session-label-scope resolves from a release-style layout", async () => {
    const layout = await tempDir("acb-age88-core-layout-");
    const tree = buildCoreReleaseTree(monorepoRoot);
    for (const [rel, content] of tree) {
      const dest = path.join(layout, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, content);
    }
    runCorePostinstall(layout);

    const probe = [
      "const url = import.meta.resolve('agents-comm-bus/session-label-scope');",
      "if (!url.endsWith('/dist/core-daemon/session-label-scope.js')) { console.error('resolved=' + url); process.exit(11); }",
      "const m = await import('agents-comm-bus/session-label-scope');",
      "if (typeof m.parseAgentsCommLabels !== 'function') process.exit(12);",
      "if (typeof m.serializeAccountLabelScope !== 'function') process.exit(13);",
      "const scope = m.parseAgentsCommLabels('telegram:main');",
      "if (!scope || scope.telegram !== 'main') process.exit(14);",
      "console.log('OK');",
    ].join("\n");

    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: layout,
    });
    assert.equal(stdout.trim(), "OK");
  });

  it("release-style pi-core extension module loads under the TS loader", async () => {
    const layout = await tempDir("acb-age88-pi-load-");
    const tree = buildCoreReleaseTree(monorepoRoot);
    for (const [rel, content] of tree) {
      const dest = path.join(layout, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, content);
    }
    runCorePostinstall(layout);

    for (const dep of ["typebox", "ws"]) {
      await linkWorkspacePackage(layout, dep);
    }

    const indexPath = path.join(layout, "extensions", "agents-comm", "index.ts");
    const probePath = path.join(layout, "probe-load.mts");
    await writeFile(
      probePath,
      `import extension from ${JSON.stringify(pathToFileURL(indexPath).href)};\nif (typeof extension !== "function") process.exit(2);\nconsole.log("OK");\n`,
    );
    const tsxBin = path.join(monorepoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const { stdout } = await run(process.execPath, [tsxBin, probePath], { cwd: layout });
    assert.equal(stdout.trim(), "OK");
  });

  it("sync CLI requires exactly one mode and defaults to non-mutating", async () => {
    const releaseDir = await tempDir("acb-age88-cli-guard-");
    const sentinel = path.join(releaseDir, "agents-comm-bus-pi-core", "DO_NOT_TOUCH.txt");
    await mkdir(path.dirname(sentinel), { recursive: true });
    await writeFile(sentinel, "sentinel\n");

    assert.throws(
      () => parseSyncPiReleaseArgs(["--release-root", releaseDir, "--core-ref", FAKE_CORE_REF]),
      /pass exactly one of --write or --verify/,
    );
    assert.throws(
      () =>
        parseSyncPiReleaseArgs([
          "--write",
          "--verify",
          "--release-root",
          releaseDir,
          "--core-ref",
          FAKE_CORE_REF,
        ]),
      /pass exactly one of --write or --verify/,
    );

    const noMode = await spawnSyncCli([
      "--release-root",
      releaseDir,
      "--core-ref",
      FAKE_CORE_REF,
    ]);
    assert.notEqual(noMode.code, 0);
    assert.match(noMode.stderr, /pass exactly one of --write or --verify/);
    assert.equal(await readFile(sentinel, "utf8"), "sentinel\n");

    const { coreSha } = await createTempCommittedCoreRepo();
    const writeReleaseDir = await tempDir("acb-age88-cli-write-");
    const code = await runSyncPiReleaseCli([
      "--write",
      "--release-root",
      writeReleaseDir,
      "--core-ref",
      coreSha,
    ]);
    assert.equal(code, 0);
    const verify = await verifyAllReleases({
      monorepoRoot,
      releaseRoot: writeReleaseDir,
      coreRef: coreSha,
    });
    assert.deepEqual(verify.mismatches, []);

    const calls: string[] = [];
    const successLogs: string[] = [];
    const errorLogs: string[] = [];
    const failedWriteCode = await runSyncPiReleaseCli(
      [
        "--write",
        "--release-root",
        writeReleaseDir,
        "--core-ref",
        coreSha,
      ],
      {
        syncReleases: async () => {
          calls.push("sync");
        },
        verifyReleases: async () => {
          calls.push("verify");
          const mismatch = { kind: "missing", path: "release-artifact.js" };
          return {
            reports: [{ repo: "agents-comm-bus-pi-core", mismatches: [mismatch] }],
            mismatches: [{ repo: "agents-comm-bus-pi-core", ...mismatch }],
          };
        },
        stdout: (message: string) => successLogs.push(message),
        stderr: (message: string) => errorLogs.push(message),
      },
    );
    assert.equal(failedWriteCode, 1, "post-write verification drift must fail the command");
    assert.deepEqual(calls, ["sync", "verify"]);
    assert.equal(successLogs.length, 0, "verification failure must not report write success");
    assert.match(errorLogs.join("\n"), /missing: release-artifact\.js/);
  });

  it("disposable production install from git+file pi-core loads the installed extension", async () => {
    const { coreRepo, coreSha } = await createTempCommittedCoreRepo();
    const probeRoot = await tempDir("acb-age88-prod-core-");
    const consumerPkg = {
      name: "age88-prod-core-probe",
      private: true,
      dependencies: {
        "@agents-comm-bus/pi-core": coreFileGitDependency(coreRepo, coreSha),
      },
    };
    await writeFile(path.join(probeRoot, "package.json"), `${JSON.stringify(consumerPkg, null, 2)}\n`);
    await writeFile(path.join(probeRoot, ".npmrc"), "install-peer-deps=false\n");
    await runShell("npm install --omit=peer --no-audit --no-fund", { cwd: probeRoot });
    for (const dep of ["typebox", "ws"]) {
      await linkWorkspacePackage(probeRoot, dep);
    }

    const installedCore = path.join(probeRoot, "node_modules", "@agents-comm-bus", "pi-core");
    assert.ok(existsSync(path.join(installedCore, "vendor-agents-comm-bus", "package.json")));
    assert.ok(existsSync(path.join(installedCore, "node_modules", "agents-comm-bus", "package.json")));

    const indexPath = path.join(installedCore, "extensions", "agents-comm", "index.ts");
    const probePath = path.join(probeRoot, "probe-installed-core.mts");
    await writeFile(
      probePath,
      `import extension from ${JSON.stringify(pathToFileURL(indexPath).href)};\nif (typeof extension !== "function") process.exit(2);\nconsole.log("OK");\n`,
    );
    const tsxBin = path.join(monorepoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const { stdout } = await run(process.execPath, [tsxBin, probePath], { cwd: probeRoot });
    assert.equal(stdout.trim(), "OK");
  });

  it("disposable production install of per-comm package copies vendor trees and loads comm extension", async () => {
    const { coreRepo, coreSha } = await createTempCommittedCoreRepo();
    const disposablePkgDir = await tempDir("acb-age88-prod-curl-pkg-");
    await syncPerCommRelease({
      monorepoRoot,
      comm: "curl",
      destRoot: disposablePkgDir,
      coreRef: coreSha,
      removeStale: true,
      enumeration: "filesystem",
    });

    const pkgPath = path.join(disposablePkgDir, "package.json");
    const originalPkgText = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(originalPkgText) as {
      dependencies: Record<string, string>;
    };
    try {
      assert.equal(
        pkg.dependencies["@agents-comm-bus/pi-core"],
        coreGitDependency(coreSha),
        "the generated release manifest must supply the pinned pi-core dependency",
      );
      // Replace only the transport host for this offline probe; the generated
      // dependency name and exact 40-hex ref above remain part of the assertion.
      pkg.dependencies["@agents-comm-bus/pi-core"] = coreFileGitDependency(coreRepo, coreSha);
      await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
      initGitRepo(disposablePkgDir);
      gitCommitAll(disposablePkgDir, "AGE-88 temp pi-curl probe");
      const commSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: disposablePkgDir,
      })
        .toString("utf8")
        .trim();
      validateCoreRef(commSha);

      const probeRoot = await tempDir("acb-age88-prod-comm-");
      await writeFile(
        path.join(probeRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "age88-prod-comm-probe",
            private: true,
            dependencies: {
              "@agents-comm-bus/pi-curl": coreFileGitDependency(disposablePkgDir, commSha),
            },
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(path.join(probeRoot, ".npmrc"), "install-peer-deps=false\n");

      await runShell("npm install --omit=peer --no-audit --no-fund", { cwd: probeRoot });
      for (const dep of ["typebox", "ws"]) {
        await linkWorkspacePackage(probeRoot, dep);
      }

      const installedCurl = path.join(probeRoot, "node_modules", "@agents-comm-bus", "pi-curl");
      const installedPkg = JSON.parse(
        await readFile(path.join(installedCurl, "package.json"), "utf8"),
      ) as { pi: { extensions: string[] } };
      const installedPiCore = path.join(
        installedCurl,
        "node_modules",
        "@agents-comm-bus",
        "pi-core",
      );
      assert.ok(existsSync(installedPiCore), "consumer install must contain nested pi-core");
      assert.ok(
        existsSync(path.resolve(installedCurl, installedPkg.pi.extensions[0])),
        "the installed package's declared pi-core extension path must exist",
      );
      assert.ok(existsSync(path.join(installedPiCore, "vendor-agents-comm-bus", "package.json")));

      assert.ok(
        existsSync(
          path.join(installedCurl, "node_modules", "agents-comm-bus", "package.json"),
        ),
        "per-comm postinstall must copy vendored agents-comm-bus",
      );

      const curlIndex = path.join(installedCurl, "extensions", "curl", "index.ts");
      const probePath = path.join(probeRoot, "probe-installed-curl.mts");
      await writeFile(
        probePath,
        `const extension = (await import(${JSON.stringify(pathToFileURL(curlIndex).href)})).default;\nif (typeof extension !== "function") process.exit(2);\nawait extension();\nconsole.log("OK");\n`,
      );
      const tsxBin = path.join(monorepoRoot, "node_modules", "tsx", "dist", "cli.mjs");
      const { stdout } = await run(process.execPath, [tsxBin, probePath], { cwd: probeRoot });
      assert.equal(stdout.trim(), "OK");
    } finally {
      await writeFile(pkgPath, originalPkgText);
    }
  });

  it("per-comm manifests pin pi-core to the supplied 40-hex ref and version 0.1.3", () => {
    for (const comm of PI_COMMS) {
      const tree = buildPerCommReleaseTree(monorepoRoot, comm, FAKE_CORE_REF);
      const pkg = JSON.parse(tree.get("package.json")!.toString("utf8"));
      const stamp = JSON.parse(tree.get("install-stamp.json")!.toString("utf8"));

      assert.equal(pkg.version, PER_COMM_VERSION);
      assert.equal(stamp.plugin_version, PER_COMM_VERSION);
      assert.equal(
        pkg.dependencies["@agents-comm-bus/pi-core"],
        coreGitDependency(FAKE_CORE_REF),
      );
      assert.doesNotMatch(
        pkg.dependencies["@agents-comm-bus/pi-core"],
        /agents-comm-bus-pi-core\.git"?\s*$/,
      );
      assert.equal(pkg.dependencies["agents-comm-bus"], undefined);
      if (comm === "telegram") {
        assert.equal(pkg.dependencies["node-telegram-bot-api"], undefined);
        assert.equal(
          tree.get("scripts/postinstall.mjs")!.toString("utf8"),
          TELEGRAM_PRODUCTION_POSTINSTALL,
        );
        assert.equal(tree.has("scripts/link-workspace-core.mjs"), false);
      }
    }
  });

  it("telegram verify guard rejects production postinstall drift, workspace helper, and excluded deps", async () => {
    const destRoot = await tempDir("acb-age88-tg-guard-");
    await syncPerCommRelease({
      monorepoRoot,
      comm: "telegram",
      destRoot,
      coreRef: FAKE_CORE_REF,
      removeStale: true,
      enumeration: "filesystem",
    });

    const expected = buildPerCommReleaseTree(monorepoRoot, "telegram", FAKE_CORE_REF);
    assert.deepEqual(await diffReleaseTree(expected, destRoot, { enumeration: "filesystem" }), []);

    const postinstallPath = path.join(destRoot, "scripts", "postinstall.mjs");
    const originalPostinstall = await readFile(postinstallPath, "utf8");
    await writeFile(postinstallPath, `${originalPostinstall}\n// mutated\n`);
    assert.ok(
      (await diffReleaseTree(expected, destRoot, { enumeration: "filesystem" })).some(
        (m) => m.path === "scripts/postinstall.mjs",
      ),
    );

    await writeFile(postinstallPath, originalPostinstall);
    await writeFile(
      path.join(destRoot, "scripts", "link-workspace-core.mjs"),
      readFileSync(path.join(monorepoRoot, "plugins/pi/telegram/scripts/link-workspace-core.mjs")),
    );
    assert.ok(
      (await diffReleaseTree(expected, destRoot, { enumeration: "filesystem" })).some(
        (m) => m.kind === "extra",
      ),
    );

    await rm(path.join(destRoot, "scripts", "link-workspace-core.mjs"));
    const pkgPath = path.join(destRoot, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    pkg.dependencies["node-telegram-bot-api"] = "^0.66.0";
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    assert.ok(
      (await diffReleaseTree(expected, destRoot, { enumeration: "filesystem" })).some(
        (m) => m.path === "package.json",
      ),
    );
  });

  it("sync + verify round-trip in temp directories", async () => {
    const releaseDir = await tempDir("acb-age88-sync-");
    const coreDest = path.join(releaseDir, "agents-comm-bus-pi-core");
    await syncCoreRelease({
      monorepoRoot,
      destRoot: coreDest,
      removeStale: true,
      enumeration: "filesystem",
    });

    let mismatches = await diffReleaseTree(buildCoreReleaseTree(monorepoRoot), coreDest, {
      enumeration: "filesystem",
    });
    assert.deepEqual(mismatches, [], formatMismatches("core", mismatches));

    for (const comm of PI_COMMS) {
      const dest = path.join(releaseDir, `agents-comm-bus-pi-${comm}`);
      await syncPerCommRelease({
        monorepoRoot,
        comm,
        destRoot: dest,
        coreRef: FAKE_CORE_REF,
        removeStale: true,
        enumeration: "filesystem",
      });
      mismatches = await diffReleaseTree(
        buildPerCommReleaseTree(monorepoRoot, comm, FAKE_CORE_REF),
        dest,
        { enumeration: "filesystem" },
      );
      assert.deepEqual(mismatches, [], formatMismatches(comm, mismatches));
    }

    const verify = await verifyAllReleases({
      monorepoRoot,
      releaseRoot: releaseDir,
      coreRef: FAKE_CORE_REF,
    });
    assert.deepEqual(verify.mismatches, []);
  });

  it("verify ignores checkout EOL conversion for text but keeps binary byte-exact", async () => {
    const dest = await tempDir("acb-age88-eol-");
    const expected = new Map<string, Buffer>([
      ["text.txt", Buffer.from("first\nsecond\n", "utf8")],
      ["binary.bin", Buffer.from([0x00, 0x0d, 0x0a, 0xff])],
    ]);
    await writeFile(path.join(dest, "text.txt"), "first\r\nsecond\r\n");
    await writeFile(path.join(dest, "binary.bin"), expected.get("binary.bin")!);

    let mismatches = await diffReleaseTree(expected, dest, { enumeration: "filesystem" });
    assert.deepEqual(mismatches, [], "CRLF checkout text must equal canonical LF source");

    await writeFile(path.join(dest, "text.txt"), "first\r\nchanged\r\n");
    mismatches = await diffReleaseTree(expected, dest, { enumeration: "filesystem" });
    assert.ok(
      mismatches.some((m) => m.kind === "content" && m.path === "text.txt"),
      "semantic text drift must remain visible after EOL normalization",
    );

    await writeFile(path.join(dest, "text.txt"), "first\r\nsecond\r\n");
    await writeFile(path.join(dest, "binary.bin"), Buffer.from([0x00, 0x0a, 0xff]));
    mismatches = await diffReleaseTree(expected, dest, { enumeration: "filesystem" });
    assert.ok(
      mismatches.some((m) => m.kind === "content" && m.path === "binary.bin"),
      "binary CRLF-like bytes must not be normalized",
    );
  });

  it("verify fails visibly when a synced file is mutated or stale extras remain", async () => {
    const releaseDir = await tempDir("acb-age88-drift-");
    await syncAllReleases({
      monorepoRoot,
      releaseRoot: releaseDir,
      coreRef: FAKE_CORE_REF,
      removeStale: true,
    });

    const telegramPkg = path.join(releaseDir, "agents-comm-bus-pi-telegram", "package.json");
    const original = await readFile(telegramPkg, "utf8");
    await writeFile(
      telegramPkg,
      original.replace(`"version": "${PER_COMM_VERSION}"`, `"version": "9.9.9"`),
    );

    let verify = await verifyAllReleases({
      monorepoRoot,
      releaseRoot: releaseDir,
      coreRef: FAKE_CORE_REF,
    });
    assert.ok(verify.mismatches.some((m) => m.repo === "agents-comm-bus-pi-telegram"));
    assert.ok(
      formatMismatches(
        "telegram",
        verify.reports.find((r) => r.repo.endsWith("telegram"))!.mismatches,
      ),
    );

    await writeFile(telegramPkg, original);
    const stale = path.join(releaseDir, "agents-comm-bus-pi-telegram", "STALE.txt");
    await writeFile(stale, "stale\n");
    verify = await verifyAllReleases({ monorepoRoot, releaseRoot: releaseDir, coreRef: FAKE_CORE_REF });
    assert.ok(verify.mismatches.some((m) => m.kind === "extra" && m.path === "STALE.txt"));

    await syncPerCommRelease({
      monorepoRoot,
      comm: "telegram",
      destRoot: path.join(releaseDir, "agents-comm-bus-pi-telegram"),
      coreRef: FAKE_CORE_REF,
      removeStale: true,
      enumeration: "filesystem",
    });
    assert.equal(existsSync(stale), false);
  });

  it("core release package.json is version 0.1.1 with vendor postinstall", () => {
    const tree = buildCoreReleaseTree(monorepoRoot);
    const pkg = JSON.parse(tree.get("package.json")!.toString("utf8"));
    assert.equal(pkg.version, PI_CORE_VERSION);
    assert.match(pkg.scripts.postinstall, /vendor-agents-comm-bus/);
    assert.equal(pkg.dependencies, undefined);
  });

  it("agents-comm-bus package.json exports ./session-label-scope", async () => {
    const pkg = JSON.parse(await readFile(path.join(agentsCommBusDir, "package.json"), "utf8")) as {
      exports?: Record<string, { import?: string; types?: string }>;
    };
    const entry = pkg.exports?.["./session-label-scope"];
    assert.ok(entry);
    assert.equal(entry.import, "./dist/core-daemon/session-label-scope.js");
    assert.equal(entry.types, "./dist/core-daemon/session-label-scope.d.ts");
    assert.ok(existsSync(path.join(agentsCommBusDir, "dist/core-daemon/session-label-scope.js")));
  });
});
