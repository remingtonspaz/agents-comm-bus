/**
 * Host-side helpers for AGENTS_COMM_LABELS (mirrors core-daemon/session-label-scope.ts).
 */

export function parseAgentsCommLabels(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return null;

  const map = {};
  for (const entry of trimmed.split(',')) {
    const piece = entry.trim();
    if (piece.length === 0) {
      throw new Error(`AGENTS_COMM_LABELS contains an empty entry in "${raw}"`);
    }
    const colon = piece.indexOf(':');
    if (colon <= 0 || colon === piece.length - 1) {
      throw new Error(`AGENTS_COMM_LABELS entry "${piece}" is malformed; expected comm:label`);
    }
    const comm = piece.slice(0, colon).trim();
    const label = piece.slice(colon + 1).trim();
    if (comm.length === 0 || label.length === 0) {
      throw new Error(`AGENTS_COMM_LABELS entry "${piece}" is malformed; expected comm:label`);
    }
    if (map[comm] !== undefined) {
      throw new Error(`AGENTS_COMM_LABELS lists comm "${comm}" more than once`);
    }
    map[comm] = label;
  }
  return map;
}

export function serializeAccountLabelScope(scope) {
  if (!scope || Object.keys(scope).length === 0) return null;
  const sorted = Object.keys(scope).sort();
  const canonical = {};
  for (const comm of sorted) {
    canonical[comm] = scope[comm];
  }
  return JSON.stringify(canonical);
}

export function accountLabelScopeFromEnv(env = process.env) {
  return serializeAccountLabelScope(parseAgentsCommLabels(env.AGENTS_COMM_LABELS));
}
