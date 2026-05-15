import { describe, it, expect } from 'vitest';
import { extractInbound } from '../../src/webhook/extract.js';
import { envelope, textMessage, buttonReplyMessage, audioMessage, adReferralMessage, statusEnvelope } from '../fixtures/webhooks.js';

describe('extractInbound', () => {
	it('returns kind=unknown for empty envelope', () => {
		expect(extractInbound({}).kind).toBe('unknown');
		expect(extractInbound(null as never).kind).toBe('unknown');
	});

	it('returns kind=status for status callbacks', () => {
		const r = extractInbound(statusEnvelope('delivered'));
		expect(r.kind).toBe('status');
		if (r.kind === 'status') expect(r.statuses[0]?.status).toBe('delivered');
	});

	it('parses a plain text message', () => {
		const r = extractInbound(envelope(textMessage('hello world', 'wamid_abc')));
		expect(r.kind).toBe('message');
		if (r.kind !== 'message') return;
		expect(r.wamid).toBe('wamid_abc');
		expect(r.whatsapp).toBe('15551234567');
		expect(r.name).toBe('Alice');
		expect(r.type).toBe('text');
		if (r.type === 'text') expect(r.text).toBe('hello world');
	});

	it('parses a button_reply with id + title', () => {
		const r = extractInbound(envelope(buttonReplyMessage('plan_done_42_3', 'Done')));
		if (r.kind !== 'message') throw new Error('expected message');
		if (!('subtype' in r) || r.subtype !== 'button_reply') throw new Error('expected button_reply');
		expect(r.buttonId).toBe('plan_done_42_3');
		expect(r.buttonTitle).toBe('Done');
	});

	it('parses an audio message and exposes audioId', () => {
		const r = extractInbound(envelope(audioMessage('media_123')));
		if (r.kind !== 'message' || r.type !== 'audio') throw new Error('expected audio');
		expect(r.audioId).toBe('media_123');
	});

	it('marks ad-referral messages with fromAd + referral data', () => {
		const r = extractInbound(envelope(adReferralMessage('hey', 'CTWA_xyz')));
		if (r.kind !== 'message') throw new Error('expected message');
		expect(r.fromAd).toBe(true);
		expect(r.referral?.ctwa_clid).toBe('CTWA_xyz');
	});

	it('handles missing profile gracefully (anonymous user)', () => {
		const env = envelope(textMessage('hi'), { wa_id: '15551234567' });
		const r = extractInbound(env);
		if (r.kind !== 'message') throw new Error('expected message');
		expect(r.name).toBeNull();
	});

	it('preserves the timestamp when present', () => {
		const env = envelope(textMessage('hi', 'wamid_t', '15551234567'));
		const r = extractInbound(env);
		if (r.kind !== 'message') throw new Error('expected message');
		expect(r.timestamp).toBe('1730000000');
	});

	it('text with empty body returns empty string, not undefined', () => {
		const r = extractInbound(
			envelope({ id: 'wamid_e', from: '5551', type: 'text', text: { body: '' } }),
		);
		if (r.kind !== 'message') throw new Error('expected message');
		expect(r.type).toBe('text');
		expect(r.text).toBe('');
	});

	it('list_reply interactive sets subtype + listId + listTitle', () => {
		const r = extractInbound(
			envelope({
				id: 'wamid_l',
				from: '5551',
				type: 'interactive',
				interactive: { type: 'list_reply', list_reply: { id: 'option_a', title: 'Option A' } },
			}),
		);
		if (r.kind !== 'message' || !('subtype' in r)) throw new Error('expected message');
		expect(r.subtype).toBe('list_reply');
		expect(r.listId).toBe('option_a');
		expect(r.listTitle).toBe('Option A');
	});

	it('unknown interactive subtype falls through to subtype=interactive', () => {
		const r = extractInbound(
			envelope({
				id: 'wamid_u',
				from: '5551',
				type: 'interactive',
				interactive: { type: 'mystery' as never },
			}),
		);
		if (r.kind !== 'message' || !('subtype' in r)) throw new Error('expected message');
		expect(r.subtype).toBe('interactive');
	});

	it('template button (type=button) exposes payload + text', () => {
		const r = extractInbound(
			envelope({
				id: 'wamid_b',
				from: '5551',
				type: 'button',
				button: { payload: 'opt_in_cta', text: 'Quero Conversar' },
			}),
		);
		if (r.kind !== 'message' || !('subtype' in r)) throw new Error('expected message');
		expect(r.subtype).toBe('template_button');
		expect(r.buttonPayload).toBe('opt_in_cta');
		expect(r.buttonText).toBe('Quero Conversar');
	});

	it('image message exposes imageId + caption', () => {
		const r = extractInbound(
			envelope({
				id: 'wamid_i',
				from: '5551',
				type: 'image',
				image: { id: 'img_1', caption: 'a kitten' },
			}),
		);
		if (r.kind !== 'message') throw new Error('expected message');
		expect(r.imageId).toBe('img_1');
		expect(r.caption).toBe('a kitten');
	});

	it('image message with no caption defaults caption to empty string', () => {
		const r = extractInbound(
			envelope({
				id: 'wamid_i2',
				from: '5551',
				type: 'image',
				image: { id: 'img_2' },
			}),
		);
		if (r.kind !== 'message') throw new Error('expected message');
		expect(r.caption).toBe('');
	});

	it('video message exposes videoId + caption', () => {
		const r = extractInbound(
			envelope({
				id: 'wamid_v',
				from: '5551',
				type: 'video',
				video: { id: 'vid_1', caption: 'short clip' },
			}),
		);
		if (r.kind !== 'message') throw new Error('expected message');
		expect(r.videoId).toBe('vid_1');
		expect(r.caption).toBe('short clip');
	});

	it('document message exposes documentId + filename', () => {
		const r = extractInbound(
			envelope({
				id: 'wamid_d',
				from: '5551',
				type: 'document',
				document: { id: 'doc_1', filename: 'report.pdf' },
			}),
		);
		if (r.kind !== 'message') throw new Error('expected message');
		expect(r.documentId).toBe('doc_1');
		expect(r.filename).toBe('report.pdf');
	});

	it('location message exposes lat/long', () => {
		const r = extractInbound(
			envelope({
				id: 'wamid_loc',
				from: '5551',
				type: 'location',
				location: { latitude: 40.7, longitude: -74 },
			}),
		);
		if (r.kind !== 'message') throw new Error('expected message');
		expect(r.location).toEqual({ latitude: 40.7, longitude: -74 });
	});

	it('returns unknown when messages array is absent', () => {
		const env: import('../../src/types.js').InboundEnvelope = {
			entry: [{ changes: [{ value: { contacts: [{ wa_id: '5551' }] } }] }],
		};
		expect(extractInbound(env).kind).toBe('unknown');
	});

	it('returns unknown when contacts array is absent', () => {
		const env: import('../../src/types.js').InboundEnvelope = {
			entry: [{ changes: [{ value: { messages: [textMessage('hi')] } }] }],
		};
		expect(extractInbound(env).kind).toBe('unknown');
	});

	it('returns unknown when messages array is empty', () => {
		const env: import('../../src/types.js').InboundEnvelope = {
			entry: [{ changes: [{ value: { contacts: [{ wa_id: '5551' }], messages: [] } }] }],
		};
		expect(extractInbound(env).kind).toBe('unknown');
	});

	it('does NOT mark fromAd when referral has no ctwa_clid', () => {
		const r = extractInbound(
			envelope({
				id: 'wamid_x',
				from: '5551',
				type: 'text',
				text: { body: 'hi' },
				referral: { source_type: 'organic' },
			}),
		);
		if (r.kind !== 'message') throw new Error('expected message');
		expect(r.fromAd).toBeUndefined();
		expect(r.referral).toBeUndefined();
	});

	it('does NOT set audioId when audio.id is missing', () => {
		const r = extractInbound(envelope({ id: 'wamid_a', from: '5551', type: 'audio', audio: {} }));
		if (r.kind !== 'message') throw new Error('expected message');
		expect((r as { audioId?: string }).audioId).toBeUndefined();
	});

	it('button_reply without title sets buttonId only', () => {
		const r = extractInbound(
			envelope({
				id: 'wamid_br',
				from: '5551',
				type: 'interactive',
				interactive: { type: 'button_reply', button_reply: { id: 'no_title' } },
			}),
		);
		if (r.kind !== 'message' || !('subtype' in r)) throw new Error('expected message');
		expect(r.subtype).toBe('button_reply');
		expect(r.buttonId).toBe('no_title');
		expect((r as { buttonTitle?: string }).buttonTitle).toBeUndefined();
	});
});
