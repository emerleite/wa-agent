import { describe, it, expect } from 'vitest';
import { PT_BR_INTENT_TRIGGERS, matchPtBrIntent } from '../../src/ai/pt_br_intents.js';

describe('PT_BR_INTENT_TRIGGERS regex pack', () => {
	it('help matches greetings and menu asks at the start of the message', () => {
		expect(PT_BR_INTENT_TRIGGERS.help.test('oi')).toBe(true);
		expect(PT_BR_INTENT_TRIGGERS.help.test('olá')).toBe(true);
		expect(PT_BR_INTENT_TRIGGERS.help.test('Menu')).toBe(true);
		expect(PT_BR_INTENT_TRIGGERS.help.test('ajuda')).toBe(true);
		expect(PT_BR_INTENT_TRIGGERS.help.test('?')).toBe(true);
		expect(PT_BR_INTENT_TRIGGERS.help.test('quero cancelar')).toBe(false);
	});
	it('thanks matches variations of "obrigado"/"valeu"', () => {
		for (const t of ['obrigado', 'obrigada', 'brigado', 'valeu', 'thanks']) {
			expect(PT_BR_INTENT_TRIGGERS.thanks.test(t)).toBe(true);
		}
	});
	it('praise matches "parabéns"/"adorei"/"excelente"/"top"', () => {
		for (const t of ['parabéns pelo trabalho', 'adorei o serviço', 'excelente', 'top demais', 'incrível']) {
			expect(PT_BR_INTENT_TRIGGERS.praise.test(t)).toBe(true);
		}
	});
	it('complaint matches "ruim"/"péssimo"/"não gostei"', () => {
		for (const t of ['muito ruim', 'péssimo atendimento', 'não gostei', 'nao gostei', 'horrível']) {
			expect(PT_BR_INTENT_TRIGGERS.complaint.test(t)).toBe(true);
		}
	});
	it('cancel matches "cancel"/"reembolso"/"estornar"/"sair"', () => {
		for (const t of ['cancelar plano', 'quero reembolso', 'pode estornar', 'sair', 'não quero mais']) {
			expect(PT_BR_INTENT_TRIGGERS.cancel.test(t)).toBe(true);
		}
	});
});

describe('matchPtBrIntent', () => {
	it('returns the first matching key in iteration order', () => {
		expect(matchPtBrIntent('oi')).toBe('help');
		expect(matchPtBrIntent('valeu pela ajuda')).toBe('thanks');
		expect(matchPtBrIntent('adorei o resultado')).toBe('praise');
		expect(matchPtBrIntent('péssimo atendimento')).toBe('complaint');
		expect(matchPtBrIntent('quero cancelar')).toBe('cancel');
	});
	it('returns null for empty / whitespace / unmatched text', () => {
		expect(matchPtBrIntent('')).toBeNull();
		expect(matchPtBrIntent('   ')).toBeNull();
		expect(matchPtBrIntent('qualquer coisa aleatória sem gatilho')).toBeNull();
	});
	it('returns null on null / undefined input', () => {
		expect(matchPtBrIntent(null)).toBeNull();
		expect(matchPtBrIntent(undefined)).toBeNull();
	});

	it('iterates in declaration order — first match wins even when a later trigger would also fire', () => {
		// "obrigado pela ajuda" matches both `thanks` and `help` (via "ajuda"); help fires first (declaration order).
		// Since help is ANCHORED to start-of-message, "obrigado pela ajuda" only matches `thanks`.
		expect(matchPtBrIntent('obrigado pela ajuda')).toBe('thanks');
		// Confirm declaration order by using a text where both patterns fire from start.
		// "obrigado" matches thanks; "ajuda" (if at start) matches help.
		expect(matchPtBrIntent('ajuda com obrigado')).toBe('help'); // help fires first because starts with 'ajuda'
	});

	it('trim strips surrounding whitespace before matching', () => {
		expect(matchPtBrIntent('   ajuda   ')).toBe('help');
		expect(matchPtBrIntent('\t\nobrigado\n')).toBe('thanks');
	});
});
