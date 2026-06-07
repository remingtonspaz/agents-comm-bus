/**
 * Normalize Telegram-style HTML query prompts for Matrix custom HTML.
 * Matrix receives `format: "org.matrix.custom.html"` plus a plain fallback body.
 */
export declare function htmlToMatrixFormatted(html: string): {
    formatted_body: string;
    body: string;
};
//# sourceMappingURL=html.d.ts.map