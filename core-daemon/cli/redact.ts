export function redact<T extends { credentials_ref?: string }>(row: T): T {
  return { ...row, credentials_ref: row.credentials_ref ? "[redacted]" : row.credentials_ref };
}
