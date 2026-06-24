export type CredentialFailureKind = "unreadable" | "malformed_json" | "missing_field" | "validation";
export type CredentialResolution = {
    status: "ok";
    credentials: Record<string, unknown>;
} | {
    status: "absent";
} | {
    status: "invalid";
    failureKind: CredentialFailureKind;
    reason: string;
    path?: string;
};
/**
 * Shared first step every factory's resolveCredentials does: take a `file:`
 * credentials_ref, classify the common outcomes (not-a-file-ref / ENOENT ->
 * absent; unreadable -> invalid:unreadable; bad JSON -> invalid:malformed_json),
 * and otherwise hand back the parsed JSON + path for the factory to field-validate.
 */
export declare function readCredentialFile(ref: string): Promise<{
    status: "absent";
} | {
    status: "invalid";
    failureKind: "unreadable" | "malformed_json";
    reason: string;
    path: string;
} | {
    status: "ok";
    path: string;
    json: unknown;
}>;
//# sourceMappingURL=credential-resolution.d.ts.map