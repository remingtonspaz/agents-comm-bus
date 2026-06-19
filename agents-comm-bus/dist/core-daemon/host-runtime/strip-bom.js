/**
 * Strip a leading UTF-8 BOM (U+FEFF) from text before `JSON.parse`.
 */
export function stripBom(text) {
    return typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
//# sourceMappingURL=strip-bom.js.map