/**
 * Cookie helpers for session-token flows on Workers.
 *
 * No external dep — just parse/serialize per RFC 6265 with the modern
 * attributes we actually use (HttpOnly, Secure, SameSite, Max-Age, Path).
 */

export interface CookieOptions {
	maxAge?: number;
	path?: string;
	domain?: string;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: 'Strict' | 'Lax' | 'None';
	expires?: Date;
}

/**
 * Build a `Set-Cookie` string. Defaults are tuned for a session cookie:
 * HttpOnly, Secure, SameSite=Lax, Path=/.
 */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
	assertValidToken('name', name);
	const parts = [`${name}=${encodeURIComponent(value)}`];
	if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
	if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
	parts.push(`Path=${opts.path ?? '/'}`);
	if (opts.domain) parts.push(`Domain=${opts.domain}`);
	if (opts.secure ?? true) parts.push('Secure');
	if (opts.httpOnly ?? true) parts.push('HttpOnly');
	parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
	return parts.join('; ');
}

/**
 * `Set-Cookie` value that clears a previously-set cookie. Pass the same `path`
 * (and `domain` if any) used when it was set.
 */
export function clearCookie(name: string, opts: Pick<CookieOptions, 'path' | 'domain'> = {}): string {
	return serializeCookie(name, '', { ...opts, maxAge: 0, expires: new Date(0) });
}

/** Parse a `Cookie` header into a name → value map. Values are URL-decoded. */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const chunk of header.split(';')) {
		const eq = chunk.indexOf('=');
		if (eq < 0) continue;
		const k = chunk.slice(0, eq).trim();
		if (!k) continue;
		const v = chunk.slice(eq + 1).trim();
		try {
			out[k] = decodeURIComponent(v);
		} catch {
			out[k] = v;
		}
	}
	return out;
}

/** Convenience: pull one cookie value from a `Request`. */
export function getCookie(req: Request, name: string): string | undefined {
	return parseCookieHeader(req.headers.get('cookie'))[name];
}

function assertValidToken(field: string, s: string): void {
	if (!s || /[\s;,=]/.test(s)) throw new Error(`invalid cookie ${field}: ${JSON.stringify(s)}`);
}
