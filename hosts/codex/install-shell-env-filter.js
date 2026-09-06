// Deliberately a narrow, text-preserving editor, not a general TOML parser.
export const COMM_SHELL_FILTER = '"AGENTS_COMM_BUS_*" = "exclude"';
export const COMM_SHELL_FILTER_BLOCK = `[shell_environment_policy.filters]\n${COMM_SHELL_FILTER}`;

/** Input must have the previous managed hooks block removed. */
export function prepareShellEnvFilter(content) {
  const lines = content.split(/\r?\n/);
  let table = "";
  let filterStart = -1;
  let filterEnd = lines.length;
  let keyIndex = -1;
  const refuse = (detail) => {
    throw new Error(`Cannot install Codex shell filter: ${detail}. Convert this config layer to explicit [shell_environment_policy.filters] entries first; no config was written.`);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      if (filterStart >= 0 && filterEnd === lines.length) filterEnd = i;
      const header = line.match(/^\[([^\[\]]+)\]\s*(?:#.*)?$/);
      table = header ? header[1].trim() : "other";
      if (table.includes("shell_environment_policy") && !/^shell_environment_policy(?:\.[A-Za-z_]+)?$/.test(table)) {
        refuse("unsupported quoted or dotted shell policy table");
      }
      if (table === "shell_environment_policy.filters") {
        if (filterStart >= 0) refuse("duplicate filters table");
        filterStart = i;
      }
      continue;
    }
    if (table === "" && /^(?:shell_environment_policy|"shell_environment_policy"|'shell_environment_policy')\s*[.=]/.test(line)) refuse("inline or dotted shell policy");
    if (table === "shell_environment_policy" && /^(?:exclude|include_only|"exclude"|'exclude'|"include_only"|'include_only')\s*=/.test(line)) {
      refuse("legacy exclude/include_only cannot coexist with filters");
    }
    if (table === "shell_environment_policy" && /^(?:filters|"filters"|'filters')\s*[.=]/.test(line)) refuse("inline or dotted filters");
    if (table === "shell_environment_policy.filters") {
      const key = line.match(/^(?:"([^"]+)"|'([^']+)'|([\w-]+))\s*=/);
      if (!key) refuse("unsupported filters entry");
      if ((key[1] ?? key[2] ?? key[3]).toUpperCase() === "AGENTS_COMM_BUS_*") {
        if (keyIndex >= 0) refuse("duplicate comm filter key");
        keyIndex = i;
      }
    }
  }
  if (filterStart < 0) return { content, managedFilter: COMM_SHELL_FILTER_BLOCK };
  if (keyIndex >= 0) lines[keyIndex] = COMM_SHELL_FILTER;
  else lines.splice(filterEnd, 0, COMM_SHELL_FILTER);
  return { content: lines.join("\n"), managedFilter: "" };
}
