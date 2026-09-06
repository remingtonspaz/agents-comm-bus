import { CODEX_MCP_ENV_VAR_NAMES, formatTomlEnvVars } from "./mcp-env-vars.js";

export const PROJECT_MCP_TABLE = "mcp_servers.telegram";

export function hasProjectMcpDeclaration(content) {
  const lines = content.split(/\r?\n/);
  if (findTableRange(lines, PROJECT_MCP_TABLE) !== null) return true;

  for (const rawLine of lines) {
    const line = rawLine.replace(/^\uFEFF/, "").trimStart();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) return false;
    if (/^mcp_servers\.telegram\s*=/.test(line)) return true;
  }
  return false;
}

export function findTableRange(lines, header) {
  const headerRe = new RegExp(`^\\s*\\[${header.replace(/\./g, "\\.")}\\]\\s*(?:#.*)?$`);
  const anyHeaderRe = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headerRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (anyHeaderRe.test(lines[i])) {
      end = i;
      break;
    }
  }
  while (end > start + 1 && lines[end - 1].trim() === "") end -= 1;
  return { start, end };
}

export function spliceLines(lines, range, replacement) {
  return [
    ...lines.slice(0, range.start),
    ...replacement.split("\n"),
    ...lines.slice(range.end),
  ];
}

export function parseTomlStringArray(source, key) {
  const match = source.match(new RegExp(`${key}\\s*=\\s*\\[([^\\]]*)\\]`, "s"));
  if (!match) return null;
  const values = [];
  const itemRe = /"([^"]+)"/g;
  let item;
  while ((item = itemRe.exec(match[1] ?? "")) !== null) {
    values.push(item[1]);
  }
  return values;
}

function withoutTomlArrayAssignment(lines, key) {
  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!keyRe.test(line)) {
      kept.push(line);
      continue;
    }

    let bracketDepth =
      (line.match(/\[/g) ?? []).length - (line.match(/\]/g) ?? []).length;
    if (bracketDepth < 0 || !line.includes("[")) {
      throw new Error(`expected ${key} to be a TOML array assignment`);
    }
    while (bracketDepth > 0 && i + 1 < lines.length) {
      i += 1;
      bracketDepth +=
        (lines[i].match(/\[/g) ?? []).length - (lines[i].match(/\]/g) ?? []).length;
    }
    if (bracketDepth !== 0) {
      throw new Error(`unterminated ${key} TOML array assignment`);
    }
  }
  return kept;
}

export function upsertEnvVarsInTableLines(tableLines, envVarsLine = formatTomlEnvVars()) {
  const preserved = withoutTomlArrayAssignment(tableLines, "env_vars");
  return [...preserved, envVarsLine];
}

/**
 * When a project-local override already defines [mcp_servers.telegram], add or
 * replace only env_vars. Never create the table — the global ~/.codex entry is
 * the source when no project override exists.
 */
export function syncProjectMcpEnvVars(content, envVarsLine = formatTomlEnvVars()) {
  const lines = content.split(/\r?\n/);
  const range = findTableRange(lines, PROJECT_MCP_TABLE);
  if (range === null) return { content, changed: false };

  const currentBlock = lines.slice(range.start, range.end);
  const nextBlock = upsertEnvVarsInTableLines(currentBlock, envVarsLine);
  if (nextBlock.join("\n") === currentBlock.join("\n")) {
    return { content, changed: false };
  }

  return {
    content: spliceLines(lines, range, nextBlock.join("\n")).join("\n"),
    changed: true,
  };
}

export function assertCanonicalProjectEnvVars(content) {
  const lines = content.split(/\r?\n/);
  const range = findTableRange(lines, PROJECT_MCP_TABLE);
  if (range === null) {
    throw new Error("expected project MCP table");
  }
  const envVars = parseTomlStringArray(
    lines.slice(range.start, range.end).join("\n"),
    "env_vars",
  );
  if (!envVars) {
    throw new Error("expected env_vars array in project MCP table");
  }
  const expected = [...CODEX_MCP_ENV_VAR_NAMES].sort();
  const actual = [...envVars].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("project MCP env_vars do not match canonical set");
  }
}
