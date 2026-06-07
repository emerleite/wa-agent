/**
 * Builders for Meta webhook envelope fixtures.
 */
import type { InboundEnvelope, RawMessage } from '../../src/types.js';

export function envelope(
	message: RawMessage,
	contact: { wa_id: string; profile?: { name?: string } } = { wa_id: '15551234567', profile: { name: 'Alice' } }
): InboundEnvelope {
	return {
		entry: [
			{
				changes: [
					{
						value: {
							contacts: [contact],
							messages: [message],
						},
					},
				],
			},
		],
	};
}

export function textMessage(text: string, id = `wamid_${Math.random().toString(36).slice(2)}`, from = '15551234567'): RawMessage {
	return {
		id,
		from,
		timestamp: '1730000000',
		type: 'text',
		text: { body: text },
	};
}

export function buttonReplyMessage(buttonId: string, title = '', id = `wamid_${Math.random().toString(36).slice(2)}`, from = '15551234567'): RawMessage {
	return {
		id,
		from,
		timestamp: '1730000000',
		type: 'interactive',
		interactive: { type: 'button_reply', button_reply: { id: buttonId, title } },
	};
}

export function audioMessage(audioId: string, id = `wamid_${Math.random().toString(36).slice(2)}`, from = '15551234567'): RawMessage {
	return { id, from, type: 'audio', audio: { id: audioId } };
}

export function adReferralMessage(text: string, ctwaClid: string, id = `wamid_${Math.random().toString(36).slice(2)}`, from = '15551234567'): RawMessage {
	return {
		id,
		from,
		type: 'text',
		text: { body: text },
		referral: { ctwa_clid: ctwaClid, source_type: 'ad' },
	};
}

export function textReplyMessage(
	text: string,
	inReplyTo: string,
	id = `wamid_${Math.random().toString(36).slice(2)}`,
	from = '15551234567',
): RawMessage {
	return {
		id,
		from,
		timestamp: '1730000000',
		type: 'text',
		text: { body: text },
		context: { id: inReplyTo, from: '15550009999' },
	};
}

export function statusEnvelope(status: string): InboundEnvelope {
	return {
		entry: [
			{
				changes: [
					{
						value: { statuses: [{ status }] },
					},
				],
			},
		],
	};
}
