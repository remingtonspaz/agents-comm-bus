/**
 * Strip a leading UTF-8 BOM (U+FEFF) from text before `JSON.parse`.
 */
export function stripBom(text: string): string {
  return typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
