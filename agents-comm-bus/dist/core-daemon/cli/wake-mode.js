import { normalizeProjectPath } from "../project-path.js";
import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";
export async function wakeModeSet(options) {
    const storage = await openSqliteStorage(resolveStatePaths().database);
    try {
        const project = options.project && options.project.length > 0
            ? normalizeProjectPath(options.project)
            : "";
        await storage.setWakeMode(project, options.agent, options.mode, Date.now());
        return { ok: true };
    }
    finally {
        await storage.close();
    }
}
export async function wakeModeGet(options) {
    const storage = await openSqliteStorage(resolveStatePaths().database);
    try {
        const project = options.project && options.project.length > 0
            ? normalizeProjectPath(options.project)
            : "";
        const mode = await storage.getWakeMode(project, options.agent);
        const rows = await storage.listWakeModes();
        const scoped = rows.find((row) => row.project === project && row.agent === options.agent);
        const global = rows.find((row) => row.project === "" && row.agent === options.agent);
        const source = scoped
            ? { scope: "project", project }
            : global
                ? { scope: "global", project: "" }
                : { scope: "default", project: "" };
        return { ok: true, mode, source };
    }
    finally {
        await storage.close();
    }
}
export async function wakeModeClear(options) {
    const storage = await openSqliteStorage(resolveStatePaths().database);
    try {
        const project = options.project && options.project.length > 0
            ? normalizeProjectPath(options.project)
            : "";
        await storage.clearWakeMode(project, options.agent);
        return { ok: true };
    }
    finally {
        await storage.close();
    }
}
export async function wakeModeList() {
    const storage = await openSqliteStorage(resolveStatePaths().database);
    try {
        const rows = await storage.listWakeModes();
        return { ok: true, rows };
    }
    finally {
        await storage.close();
    }
}
//# sourceMappingURL=wake-mode.js.map