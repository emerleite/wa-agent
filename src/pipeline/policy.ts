/**
 * Policy gate — composes existing primitives (AccessGate, QuietHours) with
 * user-supplied predicates. Each predicate runs in order; the first to return
 * `{ proceed: false }` short-circuits the pipeline.
 *
 * Returning `{ proceed: true }` is a soft pass (other predicates still run).
 * Returning `null`/`undefined` means "this predicate has no opinion".
 */
import type { PipelineContext, PipelineAction, PipelineStep, StepResult } from './types.js';
import type { AccessGate } from '../gate/access_gate.js';
import type { QuietHours } from '../util/quiet_hours.js';

export interface PolicyVerdict {
	proceed: boolean;
	reason?: string;
	action?: PipelineAction;
}

export type PolicyPredicate<C extends PipelineContext = PipelineContext> = (
	ctx: C
) => Promise<PolicyVerdict | null | undefined> | PolicyVerdict | null | undefined;

export interface PolicyGateOptions<C extends PipelineContext = PipelineContext> {
	accessGate?: AccessGate | null;
	quietHours?: QuietHours | null;
	predicates?: PolicyPredicate<C>[];
	stepName?: string;
}

export class PolicyGate<C extends PipelineContext = PipelineContext> implements PipelineStep<C> {
	readonly name: string;
	readonly accessGate: AccessGate | null;
	readonly quietHours: QuietHours | null;
	readonly predicates: PolicyPredicate<C>[];

	constructor({ accessGate = null, quietHours = null, predicates = [], stepName = 'policy' }: PolicyGateOptions<C> = {}) {
		this.name = stepName;
		this.accessGate = accessGate;
		this.quietHours = quietHours;
		this.predicates = predicates;
	}

	async run(ctx: C, _decision: unknown): Promise<StepResult> {
		void _decision;
		if (this.quietHours?.isQuiet()) {
			return { action: 'silent', reason: 'quiet_hours', stop: true };
		}
		if (this.accessGate) {
			const access = await this.accessGate.check(ctx.whatsapp);
			(ctx as { access?: unknown }).access = access;
			if (!access.allowed) {
				return { action: 'silent', reason: `gate:${access.reason}`, stop: true };
			}
		}
		for (const predicate of this.predicates) {
			const v = await predicate(ctx);
			if (v && !v.proceed) {
				return {
					action: v.action ?? 'silent',
					reason: v.reason ?? 'policy_denied',
					stop: true,
				};
			}
		}
		return {};
	}
}
