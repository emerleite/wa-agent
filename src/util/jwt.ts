/**
 * Minimal HS256 JWT — sign/verify/decode helpers built on Web Crypto.
 *
 * Scope: signed tokens you embed into URLs sent over WhatsApp — renewal
 * links, magic logins, opt-in confirmations, account-link redirects. The
 * pattern: the bot mints a token carrying a small payload + an HMAC over
 * the URL-safe header.payload, the user taps a link with the token in the
 * query string, the renewal page verifies + decodes.
 *
 * NOT scope: a general-purpose JWT library. No RS256, no `exp` / `nbf`
 * enforcement, no JWS multi-sig. If you need any of that, use `jose`. The
 * primitive here is deliberately small (~100 LOC, zero deps) and constant-
 * time on verify, which covers the WhatsApp-URL use case both `aysu` and
 * `bibliafala` had to re-implement.
 *
 * Generic over the claims shape — `sign<MyClaims>(...)` / `verify<MyClaims>(...)`
 * give you typed payloads on the way in and out.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type JwtClaims = Record<string, unknown>;

export interface JwtSigner<Claims extends JwtClaims = JwtClaims> {
	sign(payload: Claims): Promise<string>;
	verify(token: string): Promise<Claims | null>;
	decodeUnsafe(token: string): Claims | null;
}

/**
 * Build a JwtSigner pre-bound to a secret. Use when the same secret signs
 * + verifies many tokens (the typical case for a single bot).
 *
 *   const jwt = createJwtSigner<{ pix: string; amount: string }>({ secret: env.PIX_JWT_SECRET });
 *   const token = await jwt.sign({ pix: '...', amount: '49.90' });
 *   const claims = await jwt.verify(token); // claims is { pix, amount } | null
 */
export function createJwtSigner<Claims extends JwtClaims = JwtClaims>({ secret }: { secret: string }): JwtSigner<Claims> {
	if (!secret) throw new Error('createJwtSigner: secret required');
	return {
		sign: (payload) => signJwt<Claims>(payload, secret),
		verify: (token) => verifyJwt<Claims>(token, secret),
		decodeUnsafe: (token) => decodeJwtUnsafe<Claims>(token),
	};
}

/**
 * Sign `payload` with HS256 using `secret`.
 */
export async function signJwt<Claims extends JwtClaims = JwtClaims>(payload: Claims, secret: string): Promise<string> {
	if (!secret) throw new Error('signJwt: secret required');
	const headerB64 = b64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
	const payloadB64 = b64url(encoder.encode(JSON.stringify(payload)));
	const data = `${headerB64}.${payloadB64}`;
	const sig = await hmacSha256(secret, data);
	return `${data}.${b64url(sig)}`;
}

/**
 * Verify `token` against `secret`. Returns the decoded claims on success,
 * `null` on any failure (malformed token, bad signature, unparseable payload).
 *
 * Constant-time signature comparison.
 */
export async function verifyJwt<Claims extends JwtClaims = JwtClaims>(token: string, secret: string): Promise<Claims | null> {
	if (!token || !secret) return null;
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
	const data = `${headerB64}.${payloadB64}`;
	const expected = await hmacSha256(secret, data);
	if (!constantTimeEqual(b64url(expected), sigB64)) return null;
	try {
		const json = decoder.decode(b64urlDecode(payloadB64));
		return JSON.parse(json) as Claims;
	} catch {
		return null;
	}
}

/**
 * Decode-only — no signature verification.
 *
 * Use when the secret can't reach the caller (e.g. a browser-side renewal
 * page that should NOT hold the signing key). The contract: trust the
 * server that issued the token, not the token itself.
 */
export function decodeJwtUnsafe<Claims extends JwtClaims = JwtClaims>(token: string): Claims | null {
	if (!token) return null;
	const parts = token.split('.');
	if (parts.length < 2) return null;
	try {
		const json = decoder.decode(b64urlDecode(parts[1] as string));
		return JSON.parse(json) as Claims;
	} catch {
		return null;
	}
}

async function hmacSha256(secret: string, data: string): Promise<ArrayBuffer> {
	const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return crypto.subtle.sign('HMAC', key, encoder.encode(data));
}

function b64url(buf: ArrayBuffer | Uint8Array): string {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text: string): Uint8Array {
	const norm = text.replace(/-/g, '+').replace(/_/g, '/');
	const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
	const binary = atob(norm + pad);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
