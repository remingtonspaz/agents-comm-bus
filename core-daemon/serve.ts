#!/usr/bin/env node
/**
 * Composition root for the agents-comm-bus daemon.
 *
 * Imports the specific comm-side and agent-side adapters and wires them
 * into the generic `runDaemon` library. This is the *only* file in the
 * package that knows about both "Claude" and "Telegram" together; the
 * daemon library and the adapter modules themselves stay decoupled.
 *
 * Adding a new comm or agent should require touching:
 *   1. The new adapter's folder under `adapters/{comm,agent}/<name>/`.
 *   2. This file (one import + one entry in the factories array).
 */
import { pathToFileURL } from "node:url";

import { runDaemon } from "./daemon.js";
import { TelegramCommAdapterFactory } from "../adapters/telegram/factory.js";
import { ClaudeBridgeFactory } from "./bridges/claude/bridge.js";
import { CodexBridgeFactory } from "./bridges/codex/bridge.js";

export async function startConfiguredDaemon(): Promise<void> {
  await runDaemon({
    commAdapterFactories: [new TelegramCommAdapterFactory()],
    agentBridgeFactories: [new ClaudeBridgeFactory(), new CodexBridgeFactory()],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startConfiguredDaemon().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
