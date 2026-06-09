import { describe, it, expect } from 'vitest';
import { normalizeIdentifier } from '../../src/util/normalize_identifier.js';

describe('normalizeIdentifier — no map', () => {
	it('uppercases and snake-cases plain ASCII input', () => {
		expect(normalizeIdentifier('ajuste de refeicao')).toBe('AJUSTE_DE_REFEICAO');
	});

	it('strips diacritics', () => {
		expect(normalizeIdentifier('Ajuste de Refeição')).toBe('AJUSTE_DE_REFEICAO');
		expect(normalizeIdentifier('código de barras')).toBe('CODIGO_DE_BARRAS');
		expect(normalizeIdentifier('informações nutricionais')).toBe('INFORMACOES_NUTRICIONAIS');
	});

	it('collapses dashes to underscores', () => {
		expect(normalizeIdentifier('codigo-de-barras')).toBe('CODIGO_DE_BARRAS');
		expect(normalizeIdentifier('a-b-c')).toBe('A_B_C');
	});

	it('treats runs of mixed spaces + dashes as one underscore', () => {
		expect(normalizeIdentifier('a  -  b')).toBe('A_B');
		expect(normalizeIdentifier('a---b')).toBe('A_B');
	});

	it('drops everything outside [A-Z_] (digits, punctuation)', () => {
		expect(normalizeIdentifier('AJUSTE_42!')).toBe('AJUSTE');
		expect(normalizeIdentifier('"quoted"')).toBe('QUOTED');
		expect(normalizeIdentifier('a.b.c')).toBe('ABC');
	});

	it('squashes runs of underscores', () => {
		expect(normalizeIdentifier('a__b___c')).toBe('A_B_C');
	});

	it('trims leading/trailing underscores', () => {
		expect(normalizeIdentifier('_AJUSTE_')).toBe('AJUSTE');
		expect(normalizeIdentifier('  ajuste  ')).toBe('AJUSTE');
	});

	it('returns empty string for null/undefined/empty', () => {
		expect(normalizeIdentifier(null)).toBe('');
		expect(normalizeIdentifier(undefined)).toBe('');
		expect(normalizeIdentifier('')).toBe('');
	});

	it('returns empty string for pure punctuation', () => {
		expect(normalizeIdentifier('!!!')).toBe('');
		expect(normalizeIdentifier('   ')).toBe('');
		expect(normalizeIdentifier('-_-')).toBe('');
	});

	it('idempotent — running twice produces the same result', () => {
		const inputs = ['Ajuste de Refeição', 'AJUSTE_DE_REFEICAO', '  ajuste-de-refeicao  '];
		for (const x of inputs) {
			const once = normalizeIdentifier(x);
			expect(normalizeIdentifier(once)).toBe(once);
		}
	});
});

describe('normalizeIdentifier — with map', () => {
	const MAP = {
		AJUSTE_DE_REFEICAO: 'meal_adjust',
		CODIGO_DE_BARRAS: 'barcode',
		OUTRO: 'other',
	} as const;

	it('resolves the normalized form to the mapped value', () => {
		expect(normalizeIdentifier('Ajuste de Refeição', { map: MAP })).toBe('meal_adjust');
		expect(normalizeIdentifier('código-de-barras', { map: MAP })).toBe('barcode');
	});

	it('returns null when normalized form is not in the map', () => {
		expect(normalizeIdentifier('mystery category', { map: MAP })).toBeNull();
	});

	it('returns fallback when normalized form is not in the map', () => {
		expect(normalizeIdentifier('mystery', { map: MAP, fallback: 'other' })).toBe('other');
	});

	it('returns fallback when input collapses to empty', () => {
		expect(normalizeIdentifier(null, { map: MAP, fallback: 'other' })).toBe('other');
		expect(normalizeIdentifier('!!!', { map: MAP, fallback: 'other' })).toBe('other');
	});

	it('returns null when input collapses to empty and no fallback', () => {
		expect(normalizeIdentifier(null, { map: MAP })).toBeNull();
		expect(normalizeIdentifier('', { map: MAP })).toBeNull();
	});

	it('supports non-string mapped values (generic over T)', () => {
		const numericMap = { ONE: 1, TWO: 2 };
		expect(normalizeIdentifier('one', { map: numericMap })).toBe(1);
		expect(normalizeIdentifier('two', { map: numericMap, fallback: 0 })).toBe(2);
		expect(normalizeIdentifier('three', { map: numericMap, fallback: 0 })).toBe(0);
	});
});

describe('normalizeIdentifier — adoption-proof shapes', () => {
	// aysu util/category.ts had MEAL_CATEGORIES — exercise that shape
	const MEAL_MAP: Record<string, 'REFEICAO' | 'FAST_FOOD' | 'OUTRO'> = {
		REFEICAO: 'REFEICAO',
		REFEICOES: 'REFEICAO',
		FASTFOOD: 'FAST_FOOD',
		FAST_FOOD: 'FAST_FOOD',
		OUTRO: 'OUTRO',
	};

	it('matches aysu category-normalizer expectations', () => {
		expect(normalizeIdentifier('Refeições', { map: MEAL_MAP, fallback: 'OUTRO' })).toBe('REFEICAO');
		expect(normalizeIdentifier('Fast Food', { map: MEAL_MAP, fallback: 'OUTRO' })).toBe('FAST_FOOD');
		expect(normalizeIdentifier('Fast-Food', { map: MEAL_MAP, fallback: 'OUTRO' })).toBe('FAST_FOOD');
		expect(normalizeIdentifier('NADA', { map: MEAL_MAP, fallback: 'OUTRO' })).toBe('OUTRO');
	});

	it('matches aysu text-classifier expectations', () => {
		const TEXT_MAP = { AJUSTE_DE_REFEICAO: 'AJUSTE_DE_REFEICAO', AJUDA: 'AJUDA', OUTRO: 'OUTRO' } as const;
		expect(normalizeIdentifier('Ajuste de Refeição', { map: TEXT_MAP, fallback: 'OUTRO' })).toBe('AJUSTE_DE_REFEICAO');
		expect(normalizeIdentifier('AJUDA', { map: TEXT_MAP, fallback: 'OUTRO' })).toBe('AJUDA');
		expect(normalizeIdentifier('hum?', { map: TEXT_MAP, fallback: 'OUTRO' })).toBe('OUTRO');
	});
});
