/**
 * Daily yes/no question with weekly progress tracking.
 *
 * From v0.2 onward: backed by Drizzle ORM.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { engagementAnswers } from '../db/schema/broadcast.js';
import type { WhatsAppClient } from '../client/whatsapp.js';

export interface ReEngagementQuestion {
	body: string;
	yesLabel?: string;
	noLabel?: string;
}

export interface ReEngagementTemplate {
	name: string;
	language?: string;
}

export interface ReEngagementOptions {
	client: WhatsAppClient;
	db: DB;
	topicId: number;
	question: ReEngagementQuestion;
	template?: ReEngagementTemplate | null;
}

export interface DayProgress {
	day_of_week: number;
	date: string;
	answer: string | null;
}

export class ReEngagement {
	readonly client: WhatsAppClient;
	readonly db: DB;
	readonly topicId: number;
	readonly question: Required<ReEngagementQuestion>;
	readonly template: ReEngagementTemplate | null;

	constructor({ client, db, topicId, question, template = null }: ReEngagementOptions) {
		if (!client || !db) throw new Error('ReEngagement: client + db required');
		if (!topicId) throw new Error('ReEngagement: topicId required');
		if (!question?.body) throw new Error('ReEngagement: question.body required');
		this.client = client;
		this.db = db;
		this.topicId = topicId;
		this.question = { yesLabel: 'Yes', noLabel: 'No', ...question };
		this.template = template;
	}

	get yesId(): string {
		return `engagement_${this.topicId}_a`;
	}
	get noId(): string {
		return `engagement_${this.topicId}_b`;
	}

	async ask(whatsapp: string, { useTemplate = false }: { useTemplate?: boolean } = {}): Promise<boolean> {
		if (useTemplate && this.template) {
			return await this.client.sendTemplate(whatsapp, {
				name: this.template.name,
				language: this.template.language || 'pt_BR',
				components: [
					{ type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: this.yesId }] },
					{ type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: this.noId }] },
				],
			});
		}
		return await this.client.sendButtons(whatsapp, {
			body: this.question.body,
			buttons: [
				{ id: this.yesId, title: this.question.yesLabel },
				{ id: this.noId, title: this.question.noLabel },
			],
		});
	}

	/**
	 * Record a user's answer. `daysAgo` defaults to 1 — answers usually arrive
	 * the day *after* the question went out, so we attribute them to yesterday.
	 */
	async recordAnswer(whatsapp: string, buttonOrAnswer: string, { daysAgo = 1 }: { daysAgo?: number } = {}): Promise<unknown> {
		const answer = buttonOrAnswer.startsWith('engagement_') ? buttonOrAnswer.split('_')[2]! : buttonOrAnswer;
		const r = await this.db
			.insert(engagementAnswers)
			.values({
				engagementId: this.topicId,
				whatsapp,
				answer,
				date: sql`date('now', ${`-${daysAgo} days`})`,
			})
			.returning();
		return r[0] ?? null;
	}

	/**
	 * Returns a 7-row array (one per day for the trailing week), with `answer`
	 * = null for days the user didn't respond. Day 1 = 7 days ago, Day 7 = today.
	 */
	async weekProgress(whatsapp: string): Promise<DayProgress[]> {
		const rows = await this.db
			.select({ date: engagementAnswers.date, answer: engagementAnswers.answer })
			.from(engagementAnswers)
			.where(
				and(
					eq(engagementAnswers.engagementId, this.topicId),
					eq(engagementAnswers.whatsapp, whatsapp),
					gte(engagementAnswers.date, sql`date('now', '-7 days')`)
				)
			);
		const byDate = new Map<string, string>();
		for (const r of rows) byDate.set(r.date, r.answer);

		const out: DayProgress[] = [];
		for (let n = 1; n <= 7; n++) {
			const d = isoDate(daysFromNow(n - 7));
			out.push({ day_of_week: n, date: d, answer: byDate.get(d) ?? null });
		}
		return out;
	}
}

function daysFromNow(offset: number): Date {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() + offset);
	return d;
}

function isoDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}
