/**
 * Dual Bearer / Basic auth guard for admin endpoints.
 *
 * Motivating shape: you want scripts / CI to hit /admin/* with `Authorization:
 * Bearer <api-key>` and humans to hit the same routes from a browser (which
 * pops a native login prompt via HTTP Basic). Both paths compare in constant
 * time via `timingSafeStringEqual` to avoid credential-length leaks.
 *
 *   const guard = requireAdminAuth(req, {
 *     bearerKey: env.ADMIN_API_KEY,
 *     basicUser: env.ADMIN_USER,
 *     basicPass: env.ADMIN_PASS,
 *   });
 *   if (guard) return guard;         // 401 with WWW-Authenticate
 *   // authorized — continue handling the request
 *
 * All three credentials are optional: if none are configured, every request
 * is denied. That's intentional — a misconfigured admin surface is a bigger
 * risk than a hard 401.
 */

export interface AdminAuthConfig {
	bearerKey?: string | null;
	basicUser?: string | null;
	basicPass?: string | null;
	/** Advertised realm in the WWW-Authenticate header. Default: `admin`. */
	realm?: string;
}

/**
 * Returns `null` if the request presents valid Bearer OR Basic credentials.
 * Otherwise returns a 401 Response with `WWW-Authenticate: Basic realm="..."`
 * so browsers pop the native login prompt.
 */
export function requireAdminAuth(req: Request, config: AdminAuthConfig): Response | null {
	const auth = req.headers.get('authorization') ?? '';

	if (auth.startsWith('Bearer ') && config.bearerKey) {
		const token = auth.slice(7);
		if (timingSafeStringEqual(token, config.bearerKey)) return null;
	}

	if (auth.startsWith('Basic ') && config.basicUser && config.basicPass) {
		try {
			const decoded = atob(auth.slice(6));
			const colon = decoded.indexOf(':');
			if (colon > 0) {
				const user = decoded.slice(0, colon);
				const pass = decoded.slice(colon + 1);
				if (timingSafeStringEqual(user, config.basicUser) && timingSafeStringEqual(pass, config.basicPass)) {
					return null;
				}
			}
		} catch {
			// bad base64 — fall through
		}
	}

	const realm = (config.realm ?? 'admin').replace(/"/g, '');
	return new Response('unauthorized', {
		status: 401,
		headers: { 'www-authenticate': `Basic realm="${realm}", charset="UTF-8"` },
	});
}

/**
 * Constant-time string comparison. Both inputs are coerced to strings first;
 * length inequality returns `false` fast (this leaks length, which is fine
 * for API keys / passwords where length is not the secret).
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
	const sa = String(a ?? '');
	const sb = String(b ?? '');
	if (sa.length !== sb.length) return false;
	let diff = 0;
	for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
	return diff === 0;
}
