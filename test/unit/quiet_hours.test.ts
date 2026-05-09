import { describe, it, expect } from 'vitest';
import { QuietHours } from '../../src/util/quiet_hours.js';

describe('QuietHours', () => {
	it('throws on malformed time', () => {
		expect(() => new QuietHours({ start: '99:99', end: '00:00' })).toThrow();
		expect(() => new QuietHours({ start: 'banana', end: '00:00' })).toThrow();
		expect(() => new QuietHours({ start: '22', end: '06:00' })).toThrow();
	});

	it('start === end means never quiet', () => {
		const qh = new QuietHours({ start: '00:00', end: '00:00' });
		expect(qh.isQuiet(new Date('2026-05-03T03:00:00Z'))).toBe(false);
		expect(qh.isQuiet(new Date('2026-05-03T15:00:00Z'))).toBe(false);
	});

	it('same-day window — quiet inside', () => {
		const qh = new QuietHours({ start: '13:00', end: '14:00' });
		expect(qh.isQuiet(new Date('2026-05-03T13:30:00Z'))).toBe(true);
	});

	it('same-day window — start is inclusive, end is exclusive', () => {
		const qh = new QuietHours({ start: '13:00', end: '14:00' });
		expect(qh.isQuiet(new Date('2026-05-03T13:00:00Z'))).toBe(true);
		expect(qh.isQuiet(new Date('2026-05-03T14:00:00Z'))).toBe(false);
	});

	it('same-day window — outside is not quiet', () => {
		const qh = new QuietHours({ start: '13:00', end: '14:00' });
		expect(qh.isQuiet(new Date('2026-05-03T12:59:00Z'))).toBe(false);
		expect(qh.isQuiet(new Date('2026-05-03T20:00:00Z'))).toBe(false);
	});

	it('wrap-midnight window — quiet late at night', () => {
		const qh = new QuietHours({ start: '22:00', end: '06:00' });
		expect(qh.isQuiet(new Date('2026-05-03T23:00:00Z'))).toBe(true);
	});

	it('wrap-midnight window — quiet early morning', () => {
		const qh = new QuietHours({ start: '22:00', end: '06:00' });
		expect(qh.isQuiet(new Date('2026-05-03T03:00:00Z'))).toBe(true);
	});

	it('wrap-midnight window — not quiet during the day', () => {
		const qh = new QuietHours({ start: '22:00', end: '06:00' });
		expect(qh.isQuiet(new Date('2026-05-03T12:00:00Z'))).toBe(false);
	});

	it('wrap-midnight window — boundaries (start inclusive, end exclusive)', () => {
		const qh = new QuietHours({ start: '22:00', end: '06:00' });
		expect(qh.isQuiet(new Date('2026-05-03T22:00:00Z'))).toBe(true);
		expect(qh.isQuiet(new Date('2026-05-03T05:59:00Z'))).toBe(true);
		expect(qh.isQuiet(new Date('2026-05-03T06:00:00Z'))).toBe(false);
	});

	it('respects timezone — 22:00 BRT = 01:00 UTC', () => {
		const qh = new QuietHours({ start: '22:00', end: '06:00', timezone: 'America/Sao_Paulo' });
		// 01:00 UTC = 22:00 BRT (UTC-3)
		expect(qh.isQuiet(new Date('2026-05-03T01:00:00Z'))).toBe(true);
		// 12:00 UTC = 09:00 BRT
		expect(qh.isQuiet(new Date('2026-05-03T12:00:00Z'))).toBe(false);
	});

	it('isActive() is the inverse of isQuiet()', () => {
		const qh = new QuietHours({ start: '13:00', end: '14:00' });
		const inside = new Date('2026-05-03T13:30:00Z');
		const outside = new Date('2026-05-03T20:00:00Z');
		expect(qh.isActive(inside)).toBe(false);
		expect(qh.isActive(outside)).toBe(true);
	});

	it('default timezone is UTC', () => {
		const qh = new QuietHours({ start: '22:00', end: '06:00' });
		expect(qh.isQuiet(new Date('2026-05-03T22:30:00Z'))).toBe(true);
		expect(qh.isQuiet(new Date('2026-05-03T15:00:00Z'))).toBe(false);
	});
});
