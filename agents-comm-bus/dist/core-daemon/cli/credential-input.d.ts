export interface CredentialInputOptions {
    botToken?: string;
    credentials?: Record<string, unknown>;
    credentialsFile?: string;
    credentialsJson?: string;
}
export declare function resolveCredentialInput(options: CredentialInputOptions): Promise<Record<string, unknown>>;
//# sourceMappingURL=credential-input.d.ts.map