#!/usr/bin/env node
/**
 * Composition root for the agents-comm-bus daemon.
 *
 * Imports agent-side bridges and dynamically loads installed comm-side
 * adapters from the central adapters directory. The daemon bundle stays
 * comm-neutral: installing a Telegram plugin ships `adapters/telegram.js`,
 * but users without Telegram do not carry that adapter in `bin/daemon.js`.
 *
 * Adding a new comm or agent should require touching:
 *   1. The new comm adapter's folder under `adapters/<name>/`.
 *   2. The plugin/staging metadata that installs `adapters/<name>.js`.
 * Agent bridges remain daemon-side and are registered here.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runDaemon } from "./daemon.js";
import { DAEMON_NAME } from "./config.js";
import { resolveStatePaths } from "./paths.js";
import { ClaudeBridgeFactory } from "./bridges/claude/bridge.js";
import { CodexBridgeFactory } from "./bridges/codex/bridge.js";
import { PiBridgeFactory } from "./bridges/pi/bridge.js";
import { loadCommAdapterFactories } from "./runtime/comm-adapter-loader.js";
const DEFAULT_CODEX_PROBE_PORT_RANGE = { min: 4500, max: 4600 };
function parseCodexPortRangeFromEnv(env = process.env) {
    const raw = env.AGENTS_COMM_BUS_CODEX_PORT_RANGE?.trim();
    if (!raw)
        return DEFAULT_CODEX_PROBE_PORT_RANGE;
    const match = /^(\d+)-(\d+)$/.exec(raw);
    if (!match)
        return DEFAULT_CODEX_PROBE_PORT_RANGE;
    const min = Number(match[1]);
    const max = Number(match[2]);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min <= 0 || max < min) {
        return DEFAULT_CODEX_PROBE_PORT_RANGE;
    }
    return { min, max };
}
export async function startConfiguredDaemon() {
    process.title = `${DAEMON_NAME} daemon`;
    const paths = resolveStatePaths({ stateRoot: process.env.AGENTS_COMM_BUS_STATE_ROOT });
    const adaptersDir = resolveAdaptersDir(paths.root, process.env);
    const commAdapterFactories = await loadCommAdapterFactories({ adaptersDir });
    await runDaemon({
        commAdapterFactories,
        adaptersDir,
        loadCommAdapterFactories: () => loadCommAdapterFactories({ adaptersDir }),
        agentBridgeFactories: [
            new ClaudeBridgeFactory(),
            new CodexBridgeFactory({ codexPortRange: parseCodexPortRangeFromEnv() }),
            new PiBridgeFactory(),
        ],
    });
}
function resolveAdaptersDir(stateRoot, env) {
    if (env.AGENTS_COMM_BUS_ADAPTERS_DIR) {
        return path.resolve(env.AGENTS_COMM_BUS_ADAPTERS_DIR);
    }
    if (env.AGENTS_COMM_BUS_BIN) {
        return path.resolve(path.dirname(env.AGENTS_COMM_BUS_BIN), "..", "adapters");
    }
    return path.join(stateRoot, "adapters");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    startConfiguredDaemon().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=serve.js.map