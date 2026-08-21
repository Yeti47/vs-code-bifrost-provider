import { describe, expect, it } from 'vitest';
import { hashString, pickRoutingTarget } from '../../src/routing';

describe('hashString', () => {
	it('is deterministic for the same input', () => {
		expect(hashString('hello world')).toBe(hashString('hello world'));
	});

	it('differs for different input', () => {
		expect(hashString('hello world')).not.toBe(hashString('goodbye world'));
	});

	it('is always a non-negative 32-bit integer', () => {
		const hash = hashString('anything');
		expect(hash).toBeGreaterThanOrEqual(0);
		expect(hash).toBeLessThan(2 ** 32);
		expect(Number.isInteger(hash)).toBe(true);
	});

	it('handles an empty string', () => {
		expect(Number.isInteger(hashString(''))).toBe(true);
	});
});

describe('pickRoutingTarget', () => {
	it('returns undefined when no weights are configured', () => {
		expect(pickRoutingTarget('conversation-1', {})).toBeUndefined();
	});

	it('returns the only label when just one is configured', () => {
		expect(pickRoutingTarget('conversation-1', { a: 1 })).toBe('a');
	});

	it('is deterministic: the same identity always picks the same label', () => {
		const weights = { a: 1, b: 1, c: 1 };
		const first = pickRoutingTarget('same conversation', weights);

		for (let i = 0; i < 20; i++) {
			expect(pickRoutingTarget('same conversation', weights)).toBe(first);
		}
	});

	it('picks a valid label for a range of different identities', () => {
		const weights = { a: 1, b: 1, c: 1 };
		for (let i = 0; i < 100; i++) {
			expect(['a', 'b', 'c']).toContain(pickRoutingTarget(`conversation-${i}`, weights));
		}
	});

	it('distributes many distinct identities across labels roughly evenly', () => {
		const counts: Record<string, number> = { a: 0, b: 0 };
		for (let i = 0; i < 2000; i++) {
			const label = pickRoutingTarget(`conversation-${i}`, { a: 1, b: 1 });
			counts[label!]++;
		}
		// Not asserting an exact split — just that neither label starves the other.
		expect(counts.a).toBeGreaterThan(700);
		expect(counts.b).toBeGreaterThan(700);
	});

	it('skews distribution toward the more heavily weighted label', () => {
		const counts: Record<string, number> = { a: 0, b: 0 };
		for (let i = 0; i < 2000; i++) {
			const label = pickRoutingTarget(`conversation-${i}`, { a: 3, b: 1 });
			counts[label!]++;
		}
		expect(counts.a).toBeGreaterThan(counts.b * 1.5);
	});

	it('ignores zero and negative weights', () => {
		expect(pickRoutingTarget('conversation-1', { a: 1, b: 0, c: -5 })).toBe('a');
	});

	it('returns undefined when every weight is zero or negative', () => {
		expect(pickRoutingTarget('conversation-1', { a: 0, b: -1 })).toBeUndefined();
	});

	it('is unaffected by the order weights are declared in', () => {
		const identity = 'conversation-order-check';
		expect(pickRoutingTarget(identity, { a: 1, b: 2, c: 3 })).toBe(
			pickRoutingTarget(identity, { c: 3, b: 2, a: 1 })
		);
	});
});
