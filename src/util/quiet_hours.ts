/**
 * Daily quiet-hours window. Use to gate any user-facing message channel
 * (cron broadcasts, reactive ad delivery, on-demand replies) so the bot
 * doesn't ping users at 3am.
 *
 * Times are HH:MM in 24-hour clock. The window can wrap midnight
 * (e.g. start='22:00', end='06:00' = quiet from 10pm through 6am).
 *
 *   const qh = new QuietHours({ start: '22:00', end: '06:00', timezone: 'America/Sao_Paulo' })
 *   if (qh.isQuiet()) return  // skip this send
 *
 * `timezone` accepts any IANA name. Defaults to 'UTC'. Implementation uses
 * Intl.DateTimeFormat (built into the Workers runtime, no deps).
 */

export interface QuietHoursOptions {
	/** Start of the quiet window, "HH:MM" (24h). */
	start: string;
	/** End of the quiet window, "HH:MM" (24h). Equal to `start` ⇒ never quiet. */
	end: string;
	/** IANA timezone, e.g. "America/Sao_Paulo". Defaults to "UTC". */
	timezone?: string;
}

export class QuietHours {
	readonly startMin: number;
	readonly endMin: number;
	readonly timezone: string;

	constructor({ start, end, timezone = 'UTC' }: QuietHoursOptions) {
		this.startMin = parseHHMM(start);
		this.endMin = parseHHMM(end);
		this.timezone = timezone;
	}

	/**
	 * @param now optional reference time (defaults to `new Date()`).
	 * @returns true if `now` falls inside the quiet window.
	 */
	isQuiet(now: Date = new Date()): boolean {
		if (this.startMin === this.endMin) return false;
		const minutes = minutesOfDayIn(now, this.timezone);
		if (this.startMin < this.endMin) {
			return minutes >= this.startMin && minutes < this.endMin;
		}
		return minutes >= this.startMin || minutes < this.endMin;
	}

	/** Sugar — convenient for `if (await guard.silent(...))` patterns. */
	isActive(now?: Date): boolean {
		return !this.isQuiet(now);
	}
}

function parseHHMM(s: string): number {
	const m = /^(\d{1,2}):(\d{2})$/.exec(s);
	if (!m) throw new Error(`QuietHours: invalid time "${s}", expected "HH:MM"`);
	const h = Number(m[1]);
	const min = Number(m[2]);
	if (h < 0 || h > 23 || min < 0 || min > 59) throw new Error(`QuietHours: invalid time "${s}"`);
	return h * 60 + min;
}

function minutesOfDayIn(d: Date, timezone: string): number {
	const fmt = new Intl.DateTimeFormat('en-GB', {
		timeZone: timezone,
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	});
	const parts = fmt.formatToParts(d);
	let h = 0;
	let m = 0;
	for (const p of parts) {
		if (p.type === 'hour') h = Number(p.value) % 24;
		else if (p.type === 'minute') m = Number(p.value);
	}
	return h * 60 + m;
}
