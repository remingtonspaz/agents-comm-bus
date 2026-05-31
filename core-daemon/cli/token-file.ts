import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CommId } from "agents-comm-bus-core";

import { resolveTokenFilePath } from "../paths.js";

export async function writeTokenFile(options: {
  stateRoot?: string;
  comm: CommId;
  project: string;
  agent: string;
  accountId: string;
  botToken: string;
}): Promise<string> {
  const tokenFile = resolveTokenFilePath({
    stateRoot: options.stateRoot,
    comm: options.comm,
    project: options.project,
    agent: options.agent,
    accountId: options.accountId,
  });
  await mkdir(path.dirname(tokenFile), { recursive: true });
  await writeFile(
    tokenFile,
    `${JSON.stringify({ botToken: options.botToken }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  try {
    await chmod(tokenFile, 0o600);
  } catch {
    // Best effort: Windows ACL inheritance is still per-user under the daemon state root.
  }
  return `file:${tokenFile}`;
}
