/**
 * Extract the first JSON object from arbitrary LLM output.
 *
 * Even with a strict "reply with JSON only" prompt, models occasionally wrap
 * the payload in ```json fences, prepend "Here you go:", or leak trailing
 * prose. This helper isolates the first balanced `{...}` block and parses it,
 * stripping optional ```json / ``` fences first.
 *
 * Throws if no valid object is present. Consumers that want a soft failure
 * should wrap it in try/catch — that's usually the right shape when using
 * this from inside an `AgentTool.execute` (return the parse error as the
 * tool-result string so the model re-asks the user).
 */
export function extractFirstJsonObject<T = unknown>(raw: string | null | undefined): T {
	if (!raw) throw new Error('extractFirstJsonObject: empty input');
	const cleaned = stripFences(String(raw)).trim();
	const slice = extractFirstObject(cleaned);
	return JSON.parse(slice) as T;
}

/** Same as `extractFirstJsonObject`, but returns `null` on any parse failure. */
export function tryExtractFirstJsonObject<T = unknown>(raw: string | null | undefined): T | null {
	try {
		return extractFirstJsonObject<T>(raw);
	} catch {
		return null;
	}
}

function stripFences(text: string): string {
	return text.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
}

function extractFirstObject(text: string): string {
	const start = text.indexOf('{');
	if (start === -1) throw new Error('extractFirstJsonObject: no opening brace found');
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escape) {
			escape = false;
			continue;
		}
		if (ch === '\\') {
			escape = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	throw new Error('extractFirstJsonObject: unbalanced braces');
}
