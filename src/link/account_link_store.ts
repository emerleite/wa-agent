/**
 * Account linking — redeem a short-lived web-issued code, persist the
 * resulting (identityKind, identityValue) ⇄ whatsapp mapping.
 *
 * Typical wiring:
 *
 *   const links = new AccountLinkStore({
 *     db,
 *     allowedIdentityKinds: ['google_sub', 'push_endpoint'],
 *   });
 *
 *   agent.command(['link', 'linkar'], async ({ text, user, reply }) => {
 *     const code = matchLinkCommand(text);
 *     if (!code) return reply.text('Usage: link <code>');
 *
 *     const limited = links.recordRedeemAttempt(user.whatsapp);
 *     if (limited) return reply.text('⏳ Too many attempts, try again in an hour.');
 *
 *     const r = await links.redeem(user.whatsapp, code);
 *     if (r.ok) return reply.text('✅ Connected!');
 *     return reply.text(`❌ ${r.reason}`);
 *   });
 *
 * The website side issues a code by calling `issueCode({...})` (typically
 * during a "Connect WhatsApp" flow on a signed-in page) and shows the raw
 * digits to the user. The bot only ever sees the hashed form on the way in.
 */
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { accountLinkCodes, accountLinks, type AccountLinkRow } from '../db/schema/account_links.js';

const CODE_REGEX = /^(?:link|linkar|vincular|connect)\s+(\d{4,8})$/i;

/**
 * Match-only helper for command routers. Returns the raw code on match, else
 * null. Use this to short-circuit before doing any DB work.
 */
export function matchLinkCommand(text: string | null | undefined): string | null {
	const m = (text ?? '').trim().match(CODE_REGEX);
	return m && m[1] ? m[1] : null;
}

export interface AccountLinkStoreOptions {
	db: DB;
	/**
	 * Allowlist of `identity_kind` values the bot accepts. Codes whose stored
	 * kind isn't in this set are refused — guards against a compromised web
	 * side writing arbitrary identity kinds. Defaults to an empty allowlist
	 * (everything refused) — callers must set this explicitly.
	 */
	allowedIdentityKinds?: string[];
	/** Default TTL for issued codes, in seconds. Default 600 (10 minutes). */
	defaultTtlSec?: number;
	/** Redeem attempts allowed per whatsapp per hour. Default 5. */
	maxAttemptsPerHour?: number;
}

export type RedeemReason =
	| 'rate_limited'
	| 'malformed'
	| 'not_found'
	| 'already_used'
	| 'expired'
	| 'invalid_identity_kind'
	| 'db_error';

export type RedeemResult =
	| { ok: true; identityKind: string; identityValue: string }
	| { ok: false; reason: RedeemReason };

export interface IssueCodeArgs {
	code: string;
	identityKind: string;
	identityValue: string;
	ttlSec?: number;
}

export class AccountLinkStore {
	readonly db: DB;
	readonly allowed: ReadonlySet<string>;
	readonly defaultTtlSec: number;
	readonly maxAttemptsPerHour: number;
	private readonly attempts = new Map<string, number[]>();

	constructor({ db, allowedIdentityKinds = [], defaultTtlSec = 600, maxAttemptsPerHour = 5 }: AccountLinkStoreOptions) {
		if (!db) throw new Error('AccountLinkStore: db required');
		this.db = db;
		this.allowed = new Set(allowedIdentityKinds);
		this.defaultTtlSec = defaultTtlSec;
		this.maxAttemptsPerHour = maxAttemptsPerHour;
	}

	/**
	 * Web-side helper — store a hashed code so the bot can later redeem it.
	 * Pass the raw digits; this hashes before persisting.
	 *
	 * @returns the inserted code row's id, useful for "your code: 123456" UI flows.
	 */
	async issueCode({ code, identityKind, identityValue, ttlSec }: IssueCodeArgs): Promise<number> {
		if (!/^\d{4,8}$/.test(code)) throw new Error('AccountLinkStore.issueCode: code must be 4-8 digits');
		if (!identityKind || !identityValue) {
			throw new Error('AccountLinkStore.issueCode: identityKind + identityValue required');
		}
		const codeHash = await sha256Hex(code);
		const now = nowSec();
		const expiresAt = now + (ttlSec ?? this.defaultTtlSec);
		const r = await this.db
			.insert(accountLinkCodes)
			.values({ codeHash, identityKind, identityValue, createdAt: now, expiresAt })
			.returning({ id: accountLinkCodes.id });
		return r[0]?.id ?? 0;
	}

	/**
	 * Best-effort per-isolate sliding window rate limit. Cold starts reset it;
	 * stick brute-forcers cross isolates land at the persistent Blocklist layer.
	 *
	 * @returns true when the caller has exceeded the per-hour cap. Caller should
	 *   short-circuit and reject without touching the DB.
	 */
	recordRedeemAttempt(whatsapp: string): boolean {
		const now = nowSec();
		const windowStart = now - 3600;
		const arr = (this.attempts.get(whatsapp) ?? []).filter((t) => t >= windowStart);
		arr.push(now);
		this.attempts.set(whatsapp, arr);
		return arr.length > this.maxAttemptsPerHour;
	}

	/**
	 * Verify + materialize the (identity → whatsapp) link. Idempotent: a
	 * second redeem for the same identity overwrites the whatsapp number
	 * (handy when a user replaces their phone).
	 *
	 * Codes are single-use; once redeemed, re-attempts fail with `already_used`.
	 */
	async redeem(whatsapp: string, rawCode: string): Promise<RedeemResult> {
		if (!whatsapp) return { ok: false, reason: 'malformed' };
		const code = String(rawCode || '').trim();
		if (!/^\d{4,8}$/.test(code)) return { ok: false, reason: 'malformed' };

		const codeHash = await sha256Hex(code);
		const now = nowSec();

		const found = await this.db
			.select()
			.from(accountLinkCodes)
			.where(eq(accountLinkCodes.codeHash, codeHash))
			.limit(1);
		const row = found[0];
		if (!row) return { ok: false, reason: 'not_found' };
		if (row.usedAt !== null) return { ok: false, reason: 'already_used' };
		if (row.expiresAt < now) return { ok: false, reason: 'expired' };
		if (!this.allowed.has(row.identityKind)) {
			console.warn('[AccountLinkStore] refusing unknown identity_kind:', row.identityKind);
			return { ok: false, reason: 'invalid_identity_kind' };
		}

		try {
			await this.db
				.insert(accountLinks)
				.values({
					whatsapp,
					identityKind: row.identityKind,
					identityValue: row.identityValue,
					linkedAt: now,
					lastSeenAt: now,
				})
				.onConflictDoUpdate({
					target: [accountLinks.identityKind, accountLinks.identityValue],
					set: { whatsapp, lastSeenAt: now },
				});
		} catch (e) {
			console.error('[AccountLinkStore] redeem insert failed:', e instanceof Error ? e.message : e);
			return { ok: false, reason: 'db_error' };
		}

		await this.db
			.update(accountLinkCodes)
			.set({ usedAt: now, usedByWhatsapp: whatsapp })
			.where(eq(accountLinkCodes.id, row.id));

		return { ok: true, identityKind: row.identityKind, identityValue: row.identityValue };
	}

	/** Look up a single link by identity. */
	async findByIdentity(identityKind: string, identityValue: string): Promise<AccountLinkRow | null> {
		const r = await this.db
			.select()
			.from(accountLinks)
			.where(and(eq(accountLinks.identityKind, identityKind), eq(accountLinks.identityValue, identityValue)))
			.limit(1);
		return r[0] ?? null;
	}

	/** All identities linked to a single whatsapp. */
	async listByWhatsapp(whatsapp: string): Promise<AccountLinkRow[]> {
		return await this.db.select().from(accountLinks).where(eq(accountLinks.whatsapp, whatsapp));
	}

	/** Unlink one identity. Idempotent. */
	async unlink(identityKind: string, identityValue: string): Promise<void> {
		await this.db.delete(accountLinks).where(and(eq(accountLinks.identityKind, identityKind), eq(accountLinks.identityValue, identityValue)));
	}

	/** Refresh `last_seen_at` — call when the linked identity is used. */
	async touch(identityKind: string, identityValue: string): Promise<void> {
		await this.db
			.update(accountLinks)
			.set({ lastSeenAt: nowSec() })
			.where(and(eq(accountLinks.identityKind, identityKind), eq(accountLinks.identityValue, identityValue)));
	}

	/**
	 * Periodic cleanup — drops expired-and-unused codes plus codes whose
	 * `used_at` is older than `keepUsedFor` (default 30 days, kept for
	 * audit). Run from cron.
	 */
	async cleanup({ keepUsedForSec = 30 * 86400 }: { keepUsedForSec?: number } = {}): Promise<number> {
		const now = nowSec();
		const r1 = await this.db
			.delete(accountLinkCodes)
			.where(and(lt(accountLinkCodes.expiresAt, now), sql`${accountLinkCodes.usedAt} IS NULL`))
			.returning({ id: accountLinkCodes.id });
		const r2 = await this.db
			.delete(accountLinkCodes)
			.where(and(sql`${accountLinkCodes.usedAt} IS NOT NULL`, gte(sql`${now} - ${accountLinkCodes.usedAt}`, keepUsedForSec)))
			.returning({ id: accountLinkCodes.id });
		return r1.length + r2.length;
	}
}

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

async function sha256Hex(text: string): Promise<string> {
	const buf = new TextEncoder().encode(text);
	const hash = await crypto.subtle.digest('SHA-256', buf);
	const bytes = new Uint8Array(hash);
	let out = '';
	for (let i = 0; i < bytes.length; i++) {
		out += (bytes[i] as number).toString(16).padStart(2, '0');
	}
	return out;
}
