import { describe, it, expect, vi } from 'vitest';
import { WhatsAppClient } from '../../src/client/whatsapp.js';

describe('WhatsAppClient.sendAuthenticationTemplate', () => {
	function makeClient() {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init: init ?? {} });
			return new Response('{}', { status: 200 });
		});
		globalThis.fetch = fetchImpl as unknown as typeof fetch;
		const c = new WhatsAppClient({ endpoint: 'https://graph.example/v22.0/PHONE', token: 'TOKEN' });
		return { c, calls };
	}

	it('emits the AUTHENTICATION-shape body (code in body AND URL button)', async () => {
		const { c, calls } = makeClient();
		const ok = await c.sendAuthenticationTemplate('5511999999999', '482913', { name: 'portal_otp' });
		expect(ok).toBe(true);
		const body = JSON.parse(calls[0]!.init.body as string);
		expect(body.template.name).toBe('portal_otp');
		expect(body.template.language.code).toBe('pt_BR');
		expect(body.template.components).toHaveLength(2);
		const [bodyComp, btnComp] = body.template.components;
		expect(bodyComp.type).toBe('body');
		expect(bodyComp.parameters).toEqual([{ type: 'text', text: '482913' }]);
		expect(btnComp.type).toBe('button');
		expect(btnComp.sub_type).toBe('url');
		expect(btnComp.index).toBe('0');
		expect(btnComp.parameters).toEqual([{ type: 'text', text: '482913' }]);
	});

	it('honors custom language + buttonIndex', async () => {
		const { c, calls } = makeClient();
		await c.sendAuthenticationTemplate('55', '111111', { name: 't', language: 'en_US', buttonIndex: 2 });
		const body = JSON.parse(calls[0]!.init.body as string);
		expect(body.template.language.code).toBe('en_US');
		expect(body.template.components[1].index).toBe('2');
	});

	it('throws when name or code missing', async () => {
		const { c } = makeClient();
		// @ts-expect-error missing name
		await expect(c.sendAuthenticationTemplate('55', '123', {})).rejects.toThrow(/name/);
		await expect(c.sendAuthenticationTemplate('55', '', { name: 't' })).rejects.toThrow(/code/);
	});
});
