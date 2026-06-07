function stripTags(text) {
    return text.replace(/<[^>]+>/g, "");
}
function decodeCommonEntities(text) {
    return text
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}
/**
 * Normalize Telegram-style HTML query prompts for Matrix custom HTML.
 * Matrix receives `format: "org.matrix.custom.html"` plus a plain fallback body.
 */
export function htmlToMatrixFormatted(html) {
    const formatted_body = html.trim();
    let body = html;
    body = body.replace(/<br\s*\/?>/gi, "\n");
    body = stripTags(body);
    body = decodeCommonEntities(body);
    return { formatted_body, body };
}
//# sourceMappingURL=html.js.map