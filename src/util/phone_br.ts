/**
 * Brazilian phone-number helpers.
 *
 * WhatsApp Cloud API delivers E.164 digits (no `+`), but Meta occasionally
 * omits the "9" that BR mobile numbers require (11 → 13 total digits with
 * country code). The same user can arrive as `5548996967308` on one turn and
 * `554896967308` on the next; without normalization you get duplicate leads
 * and broken lookups.
 *
 * The rule (BR mobile canonical form): 55 + DDD(2) + 9 + local(8) = 13 digits.
 * If a 12-digit input has a local prefix starting with 6/7/8/9, treat it as a
 * mobile missing its "9" and inject one; otherwise leave alone.
 *
 * `normalizeBrazilianPhone` also handles messier inputs (with formatting, with
 * or without country code) — anything unrecognizable passes through as digits.
 */

const BR_CC = '55';
const BR_DDD_PREFIX = /^[1-9]\d$/;

/** Strip every non-digit character. */
export function digits(input: string | null | undefined): string {
	return String(input ?? '').replace(/\D/g, '');
}

/**
 * Normalize any BR phone shape to canonical E.164 digits (no `+`).
 *
 * Accepts: "+55 (11) 98888-7777", "11988887777", "551188887777" (legacy 8-digit
 * mobile), "5511988887777". Returns `""` on empty input. Non-BR shapes pass
 * through as digits so consumers don't lose data.
 */
export function normalizeBrazilianPhone(input: string | null | undefined): string {
	const d = digits(input);
	if (!d) return '';

	let phone = d;

	if (!(phone.startsWith(BR_CC) && phone.length >= 12)) {
		if (phone.length === 10 || phone.length === 11) {
			const ddd = phone.slice(0, 2);
			if (!BR_DDD_PREFIX.test(ddd)) return d;
			phone = BR_CC + phone;
		} else {
			return d;
		}
	}

	if (phone.length === 12 && phone.startsWith(BR_CC)) {
		const ddd = phone.slice(2, 4);
		const rest = phone.slice(4);
		const isMobileLike = rest.length === 8 && '6789'.includes(rest[0] ?? '');
		if (BR_DDD_PREFIX.test(ddd) && isMobileLike) {
			phone = `${BR_CC}${ddd}9${rest}`;
		}
	}

	return phone;
}

/** Strip the country code — best-effort helper for display without `+55`. */
export function localizeBrazilianPhone(input: string | null | undefined): string {
	const e164 = normalizeBrazilianPhone(input);
	if (e164.startsWith(BR_CC)) return e164.slice(BR_CC.length);
	return e164;
}

/**
 * All plausible variants of a BR phone as a caller might have stored it —
 * for LOOKUPS against a store where historical rows might use different
 * formats. Complements `normalizeBrazilianPhone` (write-side): use this
 * on the read side when you can't be sure which shape the DB has.
 *
 *   phoneLookupCandidates('11988887777')
 *   // → ['11988887777', '5511988887777']
 *
 *   phoneLookupCandidates('554896967308')
 *   // → ['554896967308', '96967308', '5548996967308']
 *
 * Try each returned candidate against your table in order — the first hit
 * is the row. Idiomatic use:
 *
 *   for (const candidate of phoneLookupCandidates(input)) {
 *     const row = await db.select().from(users).where(eq(users.phone, candidate)).limit(1);
 *     if (row[0]) return row[0];
 *   }
 */
export function phoneLookupCandidates(input: string | null | undefined): string[] {
	const d = digits(input);
	if (!d) return [];
	const out = new Set<string>();
	out.add(d);
	// Bare BR number (10 fixo, 11 celular) → try with 55 prepended
	if ((d.length === 10 || d.length === 11) && !d.startsWith('55')) {
		out.add('55' + d);
	}
	// BR with country code (12 fixo, 13 celular) → try without 55 (legacy seed)
	if ((d.length === 12 || d.length === 13) && d.startsWith('55')) {
		out.add(d.slice(2));
	}
	// 12-digit mobile with country code → try injecting the missing "9"
	if (d.length === 12 && d.startsWith('55')) {
		const localFirst = d[4];
		if (localFirst && '6789'.includes(localFirst)) {
			out.add(d.slice(0, 4) + '9' + d.slice(4));
		}
	}
	return Array.from(out);
}

/**
 * Human-friendly display: `+55 11 98765-4321` (mobile) or `+55 11 3333-4444`
 * (fixed line). Falls back to `+<digits>` for unknown shapes.
 */
export function formatBrazilianPhone(input: string | null | undefined): string {
	const d = digits(input);
	if (!d) return '';
	if (d.length === 13 && d.startsWith(BR_CC)) {
		return `+55 ${d.slice(2, 4)} ${d.slice(4, 9)}-${d.slice(9)}`;
	}
	if (d.length === 12 && d.startsWith(BR_CC)) {
		return `+55 ${d.slice(2, 4)} ${d.slice(4, 8)}-${d.slice(8)}`;
	}
	return `+${d}`;
}
