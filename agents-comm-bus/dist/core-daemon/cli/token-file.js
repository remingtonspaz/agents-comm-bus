import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveTokenFilePath } from "../paths.js";
export async function writeTokenFile(options) {
    const tokenFile = resolveTokenFilePath({
        stateRoot: options.stateRoot,
        comm: options.comm,
        project: options.project,
        agent: options.agent,
        accountId: options.accountId,
    });
    await mkdir(path.dirname(tokenFile), { recursive: true });
    const body = {
        botToken: options.botToken,
        ...(options.userId && options.userId.length > 0 ? { userId: options.userId } : {}),
    };
    await writeFile(tokenFile, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
        await chmod(tokenFile, 0o600);
    }
    catch {
        // Best effort: Windows ACL inheritance is still per-user under the daemon state root.
    }
    return `file:${tokenFile}`;
}
//# sourceMappingURL=token-file.js.map