function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, "");
}

function unescapeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

/**
 * Convert Telegram-style HTML query prompts to Discord markdown.
 * Discord does not render HTML; hooks send `format: "html"` for Telegram parity.
 */
export function htmlToDiscordMarkdown(html: string): string {
  let text = html;
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => `\`\`\`\n${stripTags(inner)}\n\`\`\``);
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => `\`${stripTags(inner)}\``);
  text = text.replace(
    /<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, label) => `${stripTags(label)} (${href})`,
  );
  text = text.replace(/<(b|strong)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  text = text.replace(/<(i|em)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  text = stripTags(text);
  return unescapeHtmlEntities(text);
}
