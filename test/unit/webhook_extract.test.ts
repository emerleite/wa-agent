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
});
