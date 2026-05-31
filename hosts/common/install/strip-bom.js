/**
 * Strip a leading UTF-8 BOM (U+FEFF) from text before `JSON.parse`.
 *
 * Windows editors (Notepad, VS Code "UTF-8 with BOM") and PowerShell
 * `Out-File` / `Set-Content` default to writing a UTF-8 BOM, but Node's
 * `JSON.parse` does NOT tolerate a leading BOM — it throws `SyntaxError:
 * Unexpected token ﻿`. Every install-path reader that parses a
 * possibly-hand-edited JSON file (the dev marker, the install stamp, the
 * version sidecar) routes through this so a stray BOM never turns a valid
 * config into a parse failure.
 *
 * This bit us once for real: a BOM on `.agents-comm-bus-dev.json` made
 * `resolveDevConfig` reject the marker, silently dropping a dev checkout back
 * to production-mode resolution.
 *
 * @param {string} text
 * @returns {string} text without a single leading BOM (interior U+FEFF is left intact)
 */
export function stripBom(text) {
  return typeof text === "string" && text.charCodeAt(0) === 0xfeff
    ? text.slice(1)
    : text;
}
