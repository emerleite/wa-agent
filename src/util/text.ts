/**
 * Text helpers tuned for WhatsApp's quirks.
 */

export const INTERACTIVE_BODY_MAX = 1024;
export const TEXT_BODY_MAX = 4096;

export function whatsappBold(text: string | null | undefined): string {
	return String(text || '').replace(/\*{2,}/g, '*');
}

export function stripMarkdown(content: string | null | undefined): string {
	if (!content) return '';
	return String(content)
		.replace(/```[\s\S]*?```/g, '')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/\*([^*]+)\*/g, '$1')
		.replace(/__([^_]+)__/g, '$1')
		.replace(/_([^_]+)_/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/https?:\/\/\S+/g, '')
		.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F1FF}\u{2300}-\u{23FF}\u{1F900}-\u{1F9FF}]/gu, '')
		.replace(/^[\s>•]+/gm, '')
		.replace(/\s+/g, ' ')
		.trim();
}

export function chunkText(text: string, maxLen: number = TEXT_BODY_MAX - 64): string[] {
	if (!text) return [];
	if (text.length <= maxLen) return [text];
	const chunks: string[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(start + maxLen, text.length);
		if (end < text.length) {
			const lastNewline = text.lastIndexOf('\n', end);
			const lastPeriod = text.lastIndexOf('. ', end);
			const cut = Math.max(lastNewline, lastPeriod);
			if (cut > start + maxLen / 2) end = cut + 1;
		}
		chunks.push(text.slice(start, end).trim());
		start = end;
	}
	return chunks;
}
