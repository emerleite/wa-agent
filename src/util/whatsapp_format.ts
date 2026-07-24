/**
 * Convert common LLM-style Markdown to WhatsApp's own formatting dialect.
 *
 * WhatsApp uses a subset with different sigils:
 *   *bold*     _italic_     ~strike~     ```code```
 *
 * LLMs emit Markdown by default (`**bold**`, `# Header`, `- item`, `[t](u)`).
 * This helper rewrites those to the WhatsApp form so answers render correctly
 * in-app instead of showing literal `**` around words. Emojis + URLs pass
 * through (WhatsApp linkifies URLs automatically).
 *
 * Complementary to `stripMarkdown` in `./text.ts` (which strips everything for
 * log / trace destinations). Use this one when the string is heading to a
 * `reply.text(...)` — the string a real user will see.
 */
export function formatForWhatsapp(text: string | null | undefined): string {
	if (!text) return '';
	return String(text)
		.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
		.replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
		.replace(/^[\s]*[-*][\s]+(.+)$/gm, '• $1')
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}
