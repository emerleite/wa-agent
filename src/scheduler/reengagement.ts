/**
 * Daily yes/no question with weekly progress tracking.
 */
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
	db: D1Database;
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
	readonly db: D1Database;
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

	async recordAnswer(
		whatsapp: string,
		buttonOrAnswer: string,
		{ dateExpr = "date('now', '-1 day')" }: { dateExpr?: string } = {}
	): Promise<unknown> {
		const answer = buttonOrAnswer.startsWith('engagement_') ? buttonOrAnswer.split('_')[2] : buttonOrAnswer;
		return await this.db
			.prepare(
				`INSERT INTO engagement_answers (engagement_id, whatsapp, answer, date)
				 VALUES (?, ?, ?, ${dateExpr})
				 RETURNING *`
			)
			.bind(this.topicId, whatsapp, answer)
			.first();
	}

	async weekProgress(whatsapp: string): Promise<DayProgress[]> {
		const r = await this.db
			.prepare(
				`WITH RECURSIVE week(n, d) AS (
					SELECT 1, date('now', '-7 days')
					UNION ALL
					SELECT n + 1, date(d, '+1 day') FROM week WHERE n < 7
				)
				SELECT week.n AS day_of_week, week.d AS date, ea.answer
				FROM week
				LEFT JOIN engagement_answers ea
				  ON ea.date = week.d AND ea.engagement_id = ? AND ea.whatsapp = ?
				ORDER BY week.n`
			)
			.bind(this.topicId, whatsapp)
			.all<DayProgress>();
		return r.results ?? [];
	}
}
