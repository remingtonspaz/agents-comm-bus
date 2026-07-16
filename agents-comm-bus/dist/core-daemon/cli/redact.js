export function redact(row) {
    return { ...row, credentials_ref: row.credentials_ref ? "[redacted]" : row.credentials_ref };
}
//# sourceMappingURL=redact.js.map