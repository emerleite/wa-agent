/**
 * PT-BR intent trigger regex pack for `HeuristicFallbackClassifier` (v0.5+).
 *
 * The regexes cover the common intent buckets Brazilian WhatsApp bots
 * consistently reinvent (cancellation, thanks, praise, complaint, help,
 * greeting). They're deliberately narrow — the goal is to route the easy
 * cases without the LLM when a classifier fallback fires, not to be smart.
 *
 * Usage: hand a subset to `HeuristicFallbackClassifier` as the `fallback`
 * step. Map the trigger keys to YOUR intent vocabulary:
 *
 *   import { HeuristicFallbackClassifier, PT_BR_INTENT_TRIGGERS } from '@emerleite/wa-agent';
 *
 *   const fallback = (text: string, intents: readonly string[]) => {
 *     const t = text.trim();
 *     if (!t) return null;
 *     if (PT_BR_INTENT_TRIGGERS.cancel.test(t))    return { intent: 'cancel',   confidence: 0.9 };
 *     if (PT_BR_INTENT_TRIGGERS.thanks.test(t))    return { intent: 'thanks',   confidence: 0.9 };
 *     if (PT_BR_INTENT_TRIGGERS.complaint.test(t)) return { intent: 'complaint', confidence: 0.85 };
 *     if (PT_BR_INTENT_TRIGGERS.help.test(t))      return { intent: 'help',     confidence: 0.95 };
 *     return null;
 *   };
 *
 * Extend / override case-by-case: `const cancel = new RegExp(PT_BR_INTENT_TRIGGERS.cancel.source + '|meu-verbo', 'i')`.
 */

export const PT_BR_INTENT_TRIGGERS = {
	/** greeting / help ask — "oi", "olá", "ajuda", "menu", "?". Anchored at start-of-message. */
	help: /^(ajuda|help|oi|olá|ola|menu|comecar|começar|inicio|início|\?)/i,
	/** gratitude — "obrigado", "valeu", "brigado", "thanks". */
	thanks: /(obrigad|valeu|brigado|thanks)/i,
	/** positive feedback — "parabéns", "adorei", "amei", "excelente", "top", "incrível", "maravilhoso". */
	praise: /(parabens|parabéns|adorei|amei|excelente|top|incrivel|incrível|maravilhoso)/i,
	/** negative feedback — "ruim", "péssimo", "horrível", "odeio", "não gostei". */
	complaint: /(ruim|péssim|pessim|horrível|horrivel|odeio|nao gostei|não gostei)/i,
	/** cancellation / refund / opt-out — "cancelar", "reembolso", "estornar", "desinscrever", "sair", "não quero mais". */
	cancel: /(cancel|reembols|estorn|desinscrev|sair|nao quero mais|não quero mais)/i,
} as const;

export type PtBrIntentKey = keyof typeof PT_BR_INTENT_TRIGGERS;

/**
 * Test all triggers, return the first key that matches (in the order they
 * appear in `PT_BR_INTENT_TRIGGERS`) — or `null` if none match.
 *
 * When you have overlapping triggers you care about order for (e.g. "não
 * gostei do serviço, quero cancelar" should match `cancel` not `complaint`),
 * compose your own function that tests in your preferred priority.
 */
export function matchPtBrIntent(text: string | null | undefined): PtBrIntentKey | null {
	const t = (text ?? '').trim();
	if (!t) return null;
	for (const key of Object.keys(PT_BR_INTENT_TRIGGERS) as PtBrIntentKey[]) {
		if (PT_BR_INTENT_TRIGGERS[key].test(t)) return key;
	}
	return null;
}
