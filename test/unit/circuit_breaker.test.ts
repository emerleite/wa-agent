import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../../src/ai/circuit_breaker.js';

function clock(start = 0) {
	let now = start;
	return {
		advance(ms: number) {
			now += ms;
		},
		set(ms: number) {
			now = ms;
		},
		read: () => now,
	};
}

describe('CircuitBreaker — CLOSED state', () => {
	it('allows calls by default', () => {
		const b = new CircuitBreaker();
		expect(b.canCall('p')).toBe(true);
		expect(b.stateOf('p')).toBe('CLOSED');
	});

	it('stays CLOSED below the rate-limit threshold (3 in 30s)', () => {
		const c = clock();
		const b = new CircuitBreaker({}, c.read);
		b.recordFailure('p', '429');
		b.recordFailure('p', '429');
		expect(b.stateOf('p')).toBe('CLOSED');
		expect(b.canCall('p')).toBe(true);
	});

	it('trips OPEN at the rate-limit threshold', () => {
		const c = clock();
		const b = new CircuitBreaker({}, c.read);
		b.recordFailure('p', '429');
		b.recordFailure('p', '429');
		b.recordFailure('p', '429');
		expect(b.stateOf('p')).toBe('OPEN');
		expect(b.canCall('p')).toBe(false);
	});

	it('drops failures that fall outside the rolling window', () => {
		const c = clock();
		const b = new CircuitBreaker({}, c.read);
		b.recordFailure('p', '429');
		b.recordFailure('p', '429');
		c.advance(31_000); // outside the 30s rate-limit window
		b.recordFailure('p', '429');
		expect(b.stateOf('p')).toBe('CLOSED');
	});
});

describe('CircuitBreaker — buckets are independent', () => {
	it('mixing 429 + 5xx does NOT trip serverError bucket below its threshold', () => {
		const c = clock();
		const b = new CircuitBreaker({}, c.read);
		// 2x 429 (rateLimit bucket, threshold 3) + 4x 5xx (serverError bucket, threshold 5)
		b.recordFailure('p', '429');
		b.recordFailure('p', '429');
		b.recordFailure('p', '5xx');
		b.recordFailure('p', '5xx');
		b.recordFailure('p', '5xx');
		b.recordFailure('p', '5xx');
		expect(b.stateOf('p')).toBe('CLOSED');
	});

	it('timeout has its own bucket (threshold 3)', () => {
		const c = clock();
		const b = new CircuitBreaker({}, c.read);
		b.recordFailure('p', 'timeout');
		b.recordFailure('p', 'timeout');
		b.recordFailure('p', 'timeout');
		expect(b.stateOf('p')).toBe('OPEN');
	});

	it('unknown error kinds default to serverError bucket', () => {
		const c = clock();
		const b = new CircuitBreaker({}, c.read);
		for (let i = 0; i < 5; i++) b.recordFailure('p', 'weird_kind');
		expect(b.stateOf('p')).toBe('OPEN');
	});
});

describe('CircuitBreaker — OPEN → HALF_OPEN transition', () => {
	it('moves to HALF_OPEN after openMs elapses', () => {
		const c = clock();
		const b = new CircuitBreaker({}, c.read);
		for (let i = 0; i < 3; i++) b.recordFailure('p', '429');
		expect(b.stateOf('p')).toBe('OPEN');
		c.advance(30_001); // past the 30s openMs for rateLimit
		expect(b.canCall('p')).toBe(true);
		expect(b.stateOf('p')).toBe('HALF_OPEN');
	});

	it('stays OPEN until openMs elapses (29s still OPEN)', () => {
		const c = clock();
		const b = new CircuitBreaker({}, c.read);
		for (let i = 0; i < 3; i++) b.recordFailure('p', '429');
		c.advance(29_000);
		expect(b.canCall('p')).toBe(false);
		expect(b.stateOf('p')).toBe('OPEN');
	});
});

describe('CircuitBreaker — HALF_OPEN recovery', () => {
	it('closes after the configured success probes (default 2)', () => {
		const c = clock();
		const b = new CircuitBreaker({}, c.read);
		for (let i = 0; i < 3; i++) b.recordFailure('p', '429');
		c.advance(30_001);
		b.canCall('p'); // transition to HALF_OPEN
		b.recordSuccess('p');
		expect(b.stateOf('p')).toBe('HALF_OPEN');
		b.recordSuccess('p');
		expect(b.stateOf('p')).toBe('CLOSED');
	});

	it('failed probe sends breaker back to OPEN with doubled window', () => {
		const c = clock();
		const b = new CircuitBreaker({}, c.read);
		for (let i = 0; i < 3; i++) b.recordFailure('p', '429');
		c.advance(30_001);
		b.canCall('p'); // HALF_OPEN
		b.recordFailure('p', '429');
		expect(b.stateOf('p')).toBe('OPEN');
		// Second trip → openMs doubled (30s → 60s)
		c.advance(30_001);
		expect(b.canCall('p')).toBe(false);
		c.advance(30_000);
		expect(b.canCall('p')).toBe(true);
	});
});

describe('CircuitBreaker — exponential backoff cap', () => {
	it('does NOT exceed backoffMaxMs after many consecutive trips', () => {
		const c = clock();
		const b = new CircuitBreaker({}, c.read);
		for (let trip = 1; trip <= 6; trip++) {
			b.recordFailure('p', '429');
			b.recordFailure('p', '429');
			b.recordFailure('p', '429');
			c.advance((b.metrics().p?.openMsRemaining ?? 0) + 1);
			b.canCall('p'); // HALF_OPEN
			if (trip < 6) b.recordFailure('p', '429'); // probe fails, OPEN again
		}
		const remaining = b.metrics().p?.openMsRemaining ?? 0;
		// rateLimit backoffMaxMs is 300_000 — never above that.
		expect(remaining).toBeLessThanOrEqual(300_000);
	});
});

describe('CircuitBreaker — metrics + reset', () => {
	it('metrics exposes per-provider state', () => {
		const c = clock();
		const b = new CircuitBreaker({}, c.read);
		b.recordFailure('p1', '429');
		for (let i = 0; i < 3; i++) b.recordFailure('p2', '429');
		const m = b.metrics();
		expect(m.p1?.status).toBe('CLOSED');
		expect(m.p1?.recentFailures).toBe(1);
		expect(m.p2?.status).toBe('OPEN');
		expect(m.p2?.openMsRemaining ?? 0).toBeGreaterThan(0);
	});

	it('reset() drops a single provider entry', () => {
		const b = new CircuitBreaker();
		for (let i = 0; i < 3; i++) b.recordFailure('p', '429');
		expect(b.stateOf('p')).toBe('OPEN');
		b.reset('p');
		expect(b.stateOf('p')).toBe('CLOSED');
	});

	it('clear() drops every entry', () => {
		const b = new CircuitBreaker();
		for (let i = 0; i < 3; i++) b.recordFailure('a', '429');
		for (let i = 0; i < 3; i++) b.recordFailure('b', '429');
		b.clear();
		expect(Object.keys(b.metrics()).length).toBe(0);
	});
});

describe('CircuitBreaker — config override', () => {
	it('custom thresholds tighten the trip behavior', () => {
		const c = clock();
		const b = new CircuitBreaker(
			{ rateLimit: { threshold: 1, windowMs: 1000, openMs: 5000, backoffMaxMs: 10_000 } },
			c.read,
		);
		b.recordFailure('p', '429');
		expect(b.stateOf('p')).toBe('OPEN');
	});

	it('custom halfOpenSuccessesToClose=1 closes after one probe', () => {
		const c = clock();
		const b = new CircuitBreaker({ halfOpenSuccessesToClose: 1 }, c.read);
		for (let i = 0; i < 3; i++) b.recordFailure('p', '429');
		c.advance(30_001);
		b.canCall('p');
		b.recordSuccess('p');
		expect(b.stateOf('p')).toBe('CLOSED');
	});
});
