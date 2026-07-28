import { describe, it, expect, vi } from 'vitest';
import { WhatsAppClient } from '../../src/client/whatsapp.js';

describe('WhatsAppClient.sendUtilityTemplate', () => {
	function makeClient() {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init: init ?? {} });
			return new Response('{}', { status: 200 });
		});
		globalThis.fetch = fetchImpl as unknown as typeof fetch;
		const c = new WhatsAppClient({ endpoint: 'https://graph.example/v22.0/PHONE', token: 'T' });
		return { c, calls };
	}

	it('emits body-only when only bodyParams are given', async () => {
		const { c, calls } = makeClient();
		await c.sendUtilityTemplate('5511', { name: 'lead_notification', bodyParams: ['A', 'B'] });
		const body = JSON.parse(calls[0]!.init.body as string);
		expect(body.type).toBe('template');
		expect(body.template.name).toBe('lead_notification');
		expect(body.template.language.code).toBe('pt_BR');
		expect(body.template.components).toHaveLength(1);
		expect(body.template.components[0]).toEqual({
			type: 'body',
			parameters: [
				{ type: 'text', text: 'A' },
				{ type: 'text', text: 'B' },
			],
		});
	});

	it('emits button-only when only urlButtonSuffix is given', async () => {
		const { c, calls } = makeClient();
		await c.sendUtilityTemplate('55', { name: 't', urlButtonSuffix: 'tok123' });
		const body = JSON.parse(calls[0]!.init.body as string);
		expect(body.template.components).toEqual([
			{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'tok123' }] },
		]);
	});

	it('emits both body + button when both provided', async () => {
		const { c, calls } = makeClient();
		await c.sendUtilityTemplate('55', {
			name: 't',
			bodyParams: ['x'],
			urlButtonSuffix: 'sfx',
			buttonIndex: 2,
		});
		const body = JSON.parse(calls[0]!.init.body as string);
		expect(body.template.components).toHaveLength(2);
		expect(body.template.components[0].type).toBe('body');
		expect(body.template.components[1]).toEqual({
			type: 'button',
			sub_type: 'url',
			index: '2',
			parameters: [{ type: 'text', text: 'sfx' }],
		});
	});

	it('emits empty components array when neither body nor button given', async () => {
		const { c, calls } = makeClient();
		await c.sendUtilityTemplate('55', { name: 't' });
		const body = JSON.parse(calls[0]!.init.body as string);
		expect(body.template.components).toEqual([]);
	});

	it('honors custom language', async () => {
		const { c, calls } = makeClient();
		await c.sendUtilityTemplate('55', { name: 't', language: 'en_US' });
		const body = JSON.parse(calls[0]!.init.body as string);
		expect(body.template.language.code).toBe('en_US');
	});

	it('empty urlButtonSuffix ("") still emits the button component (deliberate zero-length param)', async () => {
		const { c, calls } = makeClient();
		await c.sendUtilityTemplate('55', { name: 't', urlButtonSuffix: '' });
		const body = JSON.parse(calls[0]!.init.body as string);
		expect(body.template.components).toHaveLength(1);
		expect(body.template.components[0].sub_type).toBe('url');
	});

	it('null/undefined urlButtonSuffix skips the button component', async () => {
		const { c, calls } = makeClient();
		await c.sendUtilityTemplate('55', { name: 't', urlButtonSuffix: undefined });
		const body = JSON.parse(calls[0]!.init.body as string);
		expect(body.template.components).toEqual([]);
	});

	it('throws when name is missing', async () => {
		const { c } = makeClient();
		// @ts-expect-error missing name
		await expect(c.sendUtilityTemplate('55', {})).rejects.toThrow(/name/);
	});
});
