/**
 * Canonical event writer. Validates with Zod, writes to Cloudflare Analytics
 * Engine. No-ops gracefully when `env.EVENTS` is missing — local dev or bots
 * that don't ship telemetry don't need to wire up an AE binding.
 *
 * Generic over the event schema so consumers (e.g. a multi-tenant SaaS with
 * its own event union) can plug in their schema + numeric-field extractor +
 * id-field selector while reusing the validation, stamping, blob-shape, and
 * AE-write infrastructure. The default form uses `FrameworkEventSchema` and
 * is what `Agent` wires internally.
 *
 * AE convention (blobs / doubles / indexes):
 *   blobs[0] = event type
 *   blobs[1] = tenantId (empty string if none)
 *   blobs[2] = idField(event) — defaults to ev.whatsapp ?? ''
 *   blobs[3] = traceId
 *   blobs[4] = full JSON of the validated event
 *   indexes[0] = tenantId (for sample-by-tenant in AE queries)
 *   doubles[]  = numeric fields auto-extracted from the payload
 */
import type { z } from 'zod';
import { FrameworkEventSchema, type FrameworkEvent, type FrameworkEventInput } from './schemas.js';
import { stampBase } from './base.js';

export type Emit<TInput = FrameworkEventInput> = (input: TInput) => Promise<void>;

export interface EventsBindings {
	EVENTS?: AnalyticsEngineDataset;
}

export interface EmitOptions<TEvent extends StampedEvent = FrameworkEvent> {
	env: EventsBindings;
	tenantId?: string;
	/** Defaults to `FrameworkEventSchema`. Consumers pass their own discriminated union. */
	schema?: z.ZodType<TEvent, z.ZodTypeDef, unknown>;
	/** Defaults to extracting `latencyMs`/`planId`/`day` from `FrameworkEvent`. */
	extractDoubles?: (ev: TEvent) => number[];
	/** What goes in `blobs[2]`. Defaults to `ev.whatsapp ?? ''`. */
	idField?: (ev: TEvent) => string;
}

/** Minimum shape every event must have after `stampBase` runs. */
interface StampedEvent {
	v: 1;
	ts: string;
	traceId: string;
	type: string;
	tenantId?: string;
}

/**
 * Build an `emit` callable bound to a specific env + tenant + schema. Returned
 * function is what gets passed to stores (`emit?: Emit`).
 */
export function makeEmit<TInput = FrameworkEventInput, TEvent extends StampedEvent = FrameworkEvent>(
	opts: EmitOptions<TEvent>
): Emit<TInput> {
	const { env, tenantId, schema, extractDoubles = defaultExtractDoubles, idField = defaultIdField } = opts;
	const effectiveSchema = (schema ?? (FrameworkEventSchema as unknown as z.ZodType<TEvent, z.ZodTypeDef, unknown>));
	return async (input) => {
		const stamped = stampBase({ ...(input as object), tenantId: (input as { tenantId?: string }).tenantId ?? tenantId } as TInput & { tenantId?: string });
		const parsed = effectiveSchema.safeParse(stamped);
		if (!parsed.success) {
			console.error('[wa-agent emit] validation failed:', parsed.error.issues, 'event:', stamped);
			return;
		}
		if (!env.EVENTS) return;
		const ev = parsed.data;
		try {
			env.EVENTS.writeDataPoint({
				blobs: [ev.type, ev.tenantId ?? '', idField(ev), ev.traceId, JSON.stringify(ev)],
				doubles: extractDoubles(ev),
				indexes: [ev.tenantId ?? 'unknown'],
			});
		} catch (err) {
			console.error('[wa-agent emit] writeDataPoint failed:', err instanceof Error ? err.message : err);
		}
	};
}

function defaultExtractDoubles<T extends StampedEvent>(ev: T): number[] {
	const n: number[] = [];
	const e = ev as T & { latencyMs?: unknown; planId?: unknown; day?: unknown };
	if (typeof e.latencyMs === 'number') n.push(e.latencyMs);
	if (typeof e.planId === 'number') n.push(e.planId);
	if (typeof e.day === 'number') n.push(e.day);
	return n;
}

function defaultIdField<T extends StampedEvent>(ev: T): string {
	return (ev as T & { whatsapp?: string }).whatsapp ?? '';
}
