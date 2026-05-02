import { describe, it, expect } from 'vitest';
import { combineText, type QueueRow } from '../../src/queue/d1_coalesce_queue.js';
import { envelope, textMessage, audioMessage, buttonReplyMessage } from '../fixtures/webhooks.js';

function row(message: ReturnType<typeof textMessage>, id = 0): QueueRow {
	return {
		id,
		message_id: message.id,
		whatsapp: message.from,
		payload: JSON.stringify(envelope(message)),
		status: 'pending',
		attempts: 0,
		scheduled_at: '',
		created_at: '',
		started_at: null,
		completed_at: null,
		error_message: null,
	};
}

describe('combineText', () => {
	it('joins multiple text bodies with newlines', () => {
		const rows = [
			row(textMessage('hi', 'a'), 1),
			row(textMessage('i have', 'b'), 2),
			row(textMessage('a question', 'c'), 3),
		];
		expect(combineText(rows)).toBe('hi\ni have\na question');
	});

	it('uses placeholder for audio messages', () => {
		const rows = [row(textMessage('hi', 'a'), 1), row(audioMessage('media1', 'b'), 2)];
		expect(combineText(rows)).toBe('hi\n[audio message]');
	});

	it('uses button title for button_reply messages', () => {
		const rows = [
			row(textMessage('hi', 'a'), 1),
			row(buttonReplyMessage('plan_done_1', 'Done', 'b'), 2),
		];
		expect(combineText(rows)).toBe('hi\nDone');
	});

	it('skips messages with no extractable content', () => {
		const rows = [row(textMessage('hi', 'a'), 1), row(buttonReplyMessage('x', '', 'b'), 2)];
		// Empty title → skipped
		expect(combineText(rows)).toBe('hi');
	});

	it('returns empty string for empty rows', () => {
		expect(combineText([])).toBe('');
	});
});
