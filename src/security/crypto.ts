/**
 * Cryptographic primitives usable from Cloudflare Workers.
 *
 * All helpers wrap Web Crypto (available in the Workers runtime) and return
 * hex strings for D1-friendly storage. Nothing here allocates outside the
 * request scope.
 */

/**
 * Random numeric one-time password. Default 6 digits (~20 bits entropy) —
 * sufficient when paired with rate-limited verification (≤ 5 tries) and a
 * short TTL (≤ 10 minutes). Bump `length` if the guarantees are looser.
 */
export function generateOtpCode(length: number = 6): string {
	if (length < 1 || length > 10) throw new Error('generateOtpCode: length must be 1..10');
	const buf = new Uint8Array(4);
	crypto.getRandomValues(buf);
	const n =
		((buf[0]! << 24) >>> 0) + ((buf[1]! << 16) >>> 0) + ((buf[2]! << 8) >>> 0) + buf[3]!;
	const mod = 10 ** length;
	return String(n % mod).padStart(length, '0');
}

/**
 * Session token — cryptographically-random hex string. Default 32 bytes
 * (256 bits) which is more than enough for cookie session identifiers.
 */
export function generateRandomToken(byteLength: number = 32): string {
	if (byteLength < 1) throw new Error('generateRandomToken: byteLength must be ≥ 1');
	const buf = new Uint8Array(byteLength);
	crypto.getRandomValues(buf);
	return toHex(buf);
}

/** SHA-256 of the input string, hex-encoded. */
export async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return toHex(new Uint8Array(digest));
}

/**
 * OTP hash with per-owner salt. Pass a stable value (phone number, user id)
 * as `salt` so hashes cannot be compared across owners.
 */
export function hashOtpCode(code: string, salt: string): Promise<string> {
	return sha256Hex(`${code}:${salt}`);
}

/** Hash a session token before persisting; the plain token lives only in the cookie. */
export function hashSessionToken(token: string): Promise<string> {
	return sha256Hex(token);
}

function toHex(buf: Uint8Array): string {
	let out = '';
	for (let i = 0; i < buf.length; i++) out += buf[i]!.toString(16).padStart(2, '0');
	return out;
}
