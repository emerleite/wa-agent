/**
 * Canonical event writer. Validates with Zod, writes to Cloudflare Analytics
 * Engine. No-ops gracefully when `env.EVENTS` is missing — local dev or bots
 * that don't ship telemetry don't need to wire up an AE binding.
 *
 * AE convention (blobs / doubles / indexes):
 *   blobs[0] = event type
 *   blobs[1] = tenantId (empty string if none)
 *   blobs[2] = whatsapp (empty string if not applicable)
 *   blobs[3] = traceId
 *   blobs[4] = full JSON of the validated event
 *   indexes[0] = tenantId (for sample-by-tenant in AE queries)
 *   doubles[]  = numeric fields auto-extracted from the payload
 */
import { FrameworkEventSchema, type FrameworkEvent, type FrameworkEventInput } from './schemas.js';
import { stampBase } from './base.js';

export type Emit = (input: FrameworkEventInput) => Promise<void>;

export interface EventsBindings {
	EVENTS?: AnalyticsEngineDataset;
}

export interface EmitOptions {
	env: EventsBindings;
	tenantId?: string;
}

/**
 * Build an `emit` callable bound to a specific env + tenant. Returned function
 * is what gets passed to stores (`emit?: Emit`).
 */
export function makeEmit({ env, tenantId }: EmitOptions): Emit {
	return async (input) => {
		const stamped = stampBase({ ...input, tenantId: input.tenantId ?? tenantId });
		const parsed = FrameworkEventSchema.safeParse(stamped);
		if (!parsed.success) {
			console.error('[wa-agent emit] validation failed:', parsed.error.issues, 'event:', stamped);
			return;
		}
		if (!env.EVENTS) return;
		try {
			env.EVENTS.writeDataPoint({
				blobs: [
					parsed.data.type,
					parsed.data.tenantId ?? '',
					(parsed.data as { whatsapp?: string }).whatsapp ?? '',
					parsed.data.traceId,
					JSON.stringify(parsed.data),
				],
				doubles: extractDoubles(parsed.data),
				indexes: [parsed.data.tenantId ?? 'unknown'],
			});
		} catch (err) {
			console.error('[wa-agent emit] writeDataPoint failed:', err instanceof Error ? err.message : err);
		}
	};
}

function extractDoubles(ev: FrameworkEvent): number[] {
	const n: number[] = [];
	if ('latencyMs' in ev && typeof ev.latencyMs === 'number') n.push(ev.latencyMs);
	if ('planId' in ev && typeof ev.planId === 'number') n.push(ev.planId);
	if ('day' in ev && typeof ev.day === 'number') n.push(ev.day);
	return n;
}
