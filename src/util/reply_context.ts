/**
 * Resolve an inbound WhatsApp message to a bot-owned entity via two paths:
 * (a) explicit reply context (user tapped "reply to message"), (b) a
 * best-effort recency window when the reply pointer is missing.
 *
 * Aysu's meal-adjustment flow and any similar "edit the last X" pattern
 * reinvents this. Generic version so consumers stay ~5 lines:
 *
 *   const meal = await resolveReplyContext({
 *     inReplyToWamid: inbound.inReplyToWamid,
 *     whatsapp: user.whatsapp,
 *     byReplyWamid: (wamid) => getMealByReplyWamid(env.DB, wamid),
 *     byRecency: (whatsapp, mins) => findRecentMeal(env.DB, whatsapp, mins),
 *     withinMinutes: 10,
 *   });
 *
 * Returns the first non-null hit from either lookup — reply-pointer wins
 * over recency (the pointer is explicit user intent). Returns null when both
 * lookups return null (or when both callback functions were omitted).
 */

export interface ResolveReplyContextArgs<T> {
	/**
	 * `inbound.inReplyToWamid` when the user tapped "reply to message" —
	 * WhatsApp threads the reply visually.
	 */
	inReplyToWamid?: string | null;
	/** Sender phone. Required only if `byRecency` is set. */
	whatsapp?: string | null;
	/** Look up the bot-owned entity whose OUTBOUND wamid equals the given id. */
	byReplyWamid?: (wamid: string) => Promise<T | null>;
	/** Recency fallback: find the most recent entity for `whatsapp` within N minutes. */
	byRecency?: (whatsapp: string, withinMinutes: number) => Promise<T | null>;
	/** Recency window. Default 10 minutes — enough to catch "the meal I just sent" flows. */
	withinMinutes?: number;
}

export async function resolveReplyContext<T>({
	inReplyToWamid,
	whatsapp,
	byReplyWamid,
	byRecency,
	withinMinutes = 10,
}: ResolveReplyContextArgs<T>): Promise<T | null> {
	if (inReplyToWamid && byReplyWamid) {
		const hit = await byReplyWamid(inReplyToWamid);
		if (hit) return hit;
	}
	if (whatsapp && byRecency) {
		const hit = await byRecency(whatsapp, withinMinutes);
		if (hit) return hit;
	}
	return null;
}
