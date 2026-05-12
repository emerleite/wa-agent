/**
 * Common event base — every wa-agent event carries `v`, `ts`, `traceId`,
 * and optionally `tenantId` so multi-tenant SaaS bots can sample/index by
 * tenant in Analytics Engine.
 *
 * Versioned schema: every payload is `{ v: 1, ts, traceId, tenantId?, type, ... }`.
 * Bump `v` when you change a field's meaning in a backwards-incompatible way.
 */
import { z } from 'zod';

export const BaseEventFields = {
	v: z.literal(1),
	ts: z.string().datetime(),
	traceId: z.string().uuid(),
	tenantId: z.string().optional(),
};

export type EventInputBase = {
	traceId?: string;
	tenantId?: string;
};

/**
 * Stamp `v`, `ts`, and `traceId` (auto-generated if absent) onto a partial
 * event. The full event then gets `safeParse`'d before write — keeping the
 * "fill in framework fields, validate, write" pipeline in one place.
 */
export function stampBase<T extends EventInputBase>(input: T): T & { v: 1; ts: string; traceId: string } {
	return {
		v: 1 as const,
		ts: new Date().toISOString(),
		traceId: input.traceId ?? crypto.randomUUID(),
		...input,
	};
}
