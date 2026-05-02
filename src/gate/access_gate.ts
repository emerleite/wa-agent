/**
 * Feature gating with optional free-trial counter.
 */
import type { Tier } from '../types.js';
import type { TierProvider } from './tier_provider.js';
import type { MessageLog } from '../session/message_log.js';

export interface AccessGateOptions {
	tierProvider: TierProvider;
	log?: MessageLog | null;
	allowedTiers?: Tier[];
	freeMessageLimit?: number;
}

export type AccessReason = 'tier' | 'trial' | 'denied';

export interface AccessResult {
	allowed: boolean;
	tier: Tier;
	reason: AccessReason;
	remaining: number | null;
}

export class AccessGate {
	readonly tierProvider: TierProvider;
	readonly log: MessageLog | null;
	readonly allowedTiers: Tier[];
	readonly freeMessageLimit: number;

	constructor({ tierProvider, log = null, allowedTiers = ['premium', 'lifetime'], freeMessageLimit = 10 }: AccessGateOptions) {
		if (!tierProvider) throw new Error('AccessGate: tierProvider required');
		this.tierProvider = tierProvider;
		this.log = log;
		this.allowedTiers = allowedTiers;
		this.freeMessageLimit = freeMessageLimit;
	}

	async check(whatsapp: string): Promise<AccessResult> {
		const { tier } = await this.tierProvider.getTier(whatsapp);
		if (this.allowedTiers.includes(tier)) {
			return { allowed: true, tier, reason: 'tier', remaining: null };
		}

		if (this.freeMessageLimit > 0 && this.log) {
			const total = await this.log.totalForUser(whatsapp);
			if (total < this.freeMessageLimit) {
				return { allowed: true, tier, reason: 'trial', remaining: this.freeMessageLimit - total };
			}
		}

		return { allowed: false, tier, reason: 'denied', remaining: 0 };
	}
}
