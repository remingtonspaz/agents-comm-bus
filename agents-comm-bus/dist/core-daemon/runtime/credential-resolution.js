import { readFile } from "node:fs/promises";
/**
 * Shared first step every factory's resolveCredentials does: take a `file:`
 * credentials_ref, classify the common outcomes (not-a-file-ref / ENOENT ->
 * absent; unreadable -> invalid:unreadable; bad JSON -> invalid:malformed_json),
 * and otherwise hand back the parsed JSON + path for the factory to field-validate.
 */
export async function readCredentialFile(ref) {
    if (!ref.startsWith("file:")) {
        return { status: "absent" };
    }
    const path = ref.slice("file:".length);
    let raw;
    try {
        raw = await readFile(path, "utf8");
    }
    catch (error) {
        const code = error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "UNKNOWN";
        if (code === "ENOENT") {
            return { status: "absent" };
        }
        return {
            status: "invalid",
            failureKind: "unreadable",
            reason: `credential file unreadable: ${code}`,
            path,
        };
    }
    try {
        return { status: "ok", path, json: JSON.parse(raw) };
    }
    catch {
        return {
            status: "invalid",
            failureKind: "malformed_json",
            reason: "credential file is not valid JSON",
            path,
        };
    }
}
//# sourceMappingURL=credential-resolution.js.map