/**
 * Verify Meta webhook X-Hub-Signature-256 (HMAC-SHA256 over raw body).
 *
 * Meta computes signature over the *raw* request body, so callers must pass
 * the unparsed bytes (ArrayBuffer or Uint8Array) and the signature header.
 */
export async function verifyMetaSignature(
	secret: string | null | undefined,
	rawBody: ArrayBuffer | Uint8Array,
	signatureHeader: string | null | undefined
): Promise<boolean> {
	if (!secret || !signatureHeader) return false;
	const sig = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
	if (!sig) return false;

	const bytes = rawBody instanceof ArrayBuffer ? new Uint8Array(rawBody) : rawBody;

	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sigBuf = await crypto.subtle.sign('HMAC', key, bytes);
	const computed = Array.from(new Uint8Array(sigBuf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

	return timingSafeEqual(sig, computed);
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export interface VerifyChallengeArgs {
	mode?: string | null;
	token?: string | null;
	challenge?: string | null;
	expectedToken: string | null;
}

export interface VerifyChallengeResult {
	ok: boolean;
	challenge?: string;
}

export function handleVerifyChallenge({ mode, token, challenge, expectedToken }: VerifyChallengeArgs): VerifyChallengeResult {
	if (mode === 'subscribe' && token === expectedToken && challenge) {
		return { ok: true, challenge };
	}
	return { ok: false };
}
