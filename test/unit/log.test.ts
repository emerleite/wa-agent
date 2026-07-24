import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { log } from '../../src/util/log.js';

describe('log', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		errSpy.mockRestore();
	});

	it('start/success/finish/info emit [PREFIX] scope message via console.log', () => {
		log.start('agent.drain');
		log.success('agent.drain', 'processed 5');
		log.finish('agent.drain');
		log.info('agent.drain', 'mid');

		expect(logSpy).toHaveBeenNthCalledWith(1, '[START] agent.drain');
		expect(logSpy).toHaveBeenNthCalledWith(2, '[SUCCESS] agent.drain processed 5');
		expect(logSpy).toHaveBeenNthCalledWith(3, '[FINISH] agent.drain');
		expect(logSpy).toHaveBeenNthCalledWith(4, '[INFO] agent.drain mid');
	});

	it('serializes extra as JSON when non-empty', () => {
		log.success('router.route', 'ok', { model: 'gpt-4o', ms: 128 });
		expect(logSpy).toHaveBeenCalledWith('[SUCCESS] router.route ok {"model":"gpt-4o","ms":128}');
	});

	it('omits extra when empty object', () => {
		log.info('scope', 'msg', {});
		expect(logSpy).toHaveBeenCalledWith('[INFO] scope msg');
	});

	it('fail passes the caller error to console.error separately', () => {
		const err = new Error('boom');
		log.fail('router.route', 'provider blew up', err, { attempt: 2 });
		expect(logSpy).toHaveBeenCalledWith('[FAIL] router.route provider blew up {"attempt":2}');
		expect(errSpy).toHaveBeenCalledWith(err);
	});

	it('fail with no error argument does not call console.error', () => {
		log.fail('scope');
		expect(logSpy).toHaveBeenCalledWith('[FAIL] scope');
		expect(errSpy).not.toHaveBeenCalled();
	});
});
