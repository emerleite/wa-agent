/**
 * Upsell flow — pitch a paid plan.
 *
 * Two send modes:
 *  - `send()` — full pitch (optional video → pitch text + CTA URL). Updates
 *    the lead's funnel state to mark "already pitched".
 *  - `sendReminder()` — compact reminder for users who already saw the full
 *    pitch. No video, no funnel-state change. Configured via the optional
 *    `reminder` block.
 *
 * Why two modes: sending the same video pitch every time a free user hits a
 * paywall annoys them and does not improve conversion. Send the full pitch
 * once; on subsequent hits, send a short CTA only.
 *
 * `sendSmart()` picks between the two automatically: if the lead is already
 * in the target funnel state (e.g. `CHECKOUT`), it sends the reminder.
 * Otherwise it sends the full pitch and transitions the state.
 */
import type { WhatsAppClient } from '../client/whatsapp.js';
import type { LeadStore } from '../lead/lead_store.js';

export interface UpsellReminderConfig {
	/** Body text. Function form receives `{whatsapp, ...vars}` like `pitch`. */
	pitch: string | ((args: Record<string, unknown>) => string);
	/** CTA button label. Defaults to the main `ctaText`. */
	ctaText?: string;
	/** Override CTA URL resolver. Defaults to the main `ctaUrl`. */
	ctaUrl?: string | ((whatsapp: string, vars: Record<string, unknown>) => Promise<string> | string);
}

export interface UpsellOptions {
	client: WhatsAppClient;
	leads?: LeadStore | null;
	funnelState?: string;
	pitch: string | ((args: Record<string, unknown>) => string);
	ctaText: string;
	ctaUrl: string | ((whatsapp: string, vars: Record<string, unknown>) => Promise<string> | string);
	video?: { url: string; caption?: string } | null;
	videoDelayMs?: number;
	/** Optional shorter pitch sent on repeat hits via `sendReminder()` / `sendSmart()`. */
	reminder?: UpsellReminderConfig | null;
}

export class Upsell {
	readonly client: WhatsAppClient;
	readonly leads: LeadStore | null;
	readonly funnelState: string;
	readonly pitch: string | ((args: Record<string, unknown>) => string);
	readonly ctaText: string;
	readonly ctaUrl: string | ((whatsapp: string, vars: Record<string, unknown>) => Promise<string> | string);
	readonly video: { url: string; caption?: string } | null;
	readonly videoDelayMs: number;
	readonly reminder: UpsellReminderConfig | null;

	constructor({
		client,
		leads = null,
		funnelState = 'CHECKOUT',
		pitch,
		ctaText,
		ctaUrl,
		video = null,
		videoDelayMs = 3000,
		reminder = null,
	}: UpsellOptions) {
		if (!client) throw new Error('Upsell: client required');
		if (!pitch || !ctaText || !ctaUrl) throw new Error('Upsell: pitch, ctaText, ctaUrl required');
		this.client = client;
		this.leads = leads;
		this.funnelState = funnelState;
		this.pitch = pitch;
		this.ctaText = ctaText;
		this.ctaUrl = ctaUrl;
		this.video = video;
		this.videoDelayMs = videoDelayMs;
		this.reminder = reminder;
	}

	/**
	 * Full pitch: optional video → pitch text + CTA URL → funnel state transition.
	 */
	async send(whatsapp: string, vars: Record<string, unknown> = {}): Promise<void> {
		if (this.video?.url) {
			await this.client.sendVideoUrl(whatsapp, this.video);
			if (this.videoDelayMs > 0) await sleep(this.videoDelayMs);
		}

		const url = typeof this.ctaUrl === 'function' ? await this.ctaUrl(whatsapp, vars) : this.ctaUrl;
		const body = typeof this.pitch === 'function' ? this.pitch({ whatsapp, ...vars }) : this.pitch;

		await this.client.sendCtaUrl(whatsapp, { body, displayText: this.ctaText, url });

		if (this.leads && this.funnelState) {
			try {
				await this.leads.setFunnelState(whatsapp, this.funnelState);
			} catch (e) {
				console.error('[Upsell] funnel state:', e instanceof Error ? e.message : e);
			}
		}
	}

	/**
	 * Compact pitch: just the CTA URL message. No video, no funnel state change.
	 * Throws if no `reminder` was configured at construction time.
	 */
	async sendReminder(whatsapp: string, vars: Record<string, unknown> = {}): Promise<void> {
		if (!this.reminder) throw new Error('Upsell: sendReminder() requires reminder config');

		const ctaUrlSource = this.reminder.ctaUrl ?? this.ctaUrl;
		const url = typeof ctaUrlSource === 'function' ? await ctaUrlSource(whatsapp, vars) : ctaUrlSource;
		const body = typeof this.reminder.pitch === 'function' ? this.reminder.pitch({ whatsapp, ...vars }) : this.reminder.pitch;
		const ctaText = this.reminder.ctaText ?? this.ctaText;

		await this.client.sendCtaUrl(whatsapp, { body, displayText: ctaText, url });
	}

	/**
	 * Picks between `send()` and `sendReminder()` based on the lead's current
	 * funnel state:
	 *  - If a `reminder` is configured AND `leads` is configured AND the user
	 *    is already in `funnelState` (i.e. already pitched), send the reminder.
	 *  - Otherwise, send the full pitch.
	 *
	 * Falls back to `send()` if any prerequisite is missing — never blocks.
	 */
	async sendSmart(whatsapp: string, vars: Record<string, unknown> = {}): Promise<void> {
		if (this.reminder && this.leads) {
			try {
				const lead = await this.leads.get(whatsapp);
				if (lead?.funnel_state === this.funnelState) {
					return await this.sendReminder(whatsapp, vars);
				}
			} catch (e) {
				console.error('[Upsell] sendSmart lead lookup:', e instanceof Error ? e.message : e);
			}
		}
		return await this.send(whatsapp, vars);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
