import { describe, expect, it } from 'vitest';
import { ReasoningCache } from '../../src/reasoningCache';

describe('ReasoningCache', () => {
	it('returns reasoning recorded against a tool call id', () => {
		const cache = new ReasoningCache();
		const model = cache.forModel('deepseek-v4-pro');

		model.remember(['call-1'], { text: 'thinking hard', textField: 'reasoning_content' });

		expect(model.lookup(['call-1'])?.text).toBe('thinking hard');
	});

	it('records the same reasoning against every tool call in the turn', () => {
		const cache = new ReasoningCache();
		const model = cache.forModel('deepseek-v4-pro');

		model.remember(['call-1', 'call-2'], { text: 'thinking hard', textField: 'reasoning_content' });

		expect(model.lookup(['call-2'])?.text).toBe('thinking hard');
		expect(model.lookup(['call-1'])?.text).toBe('thinking hard');
	});

	it('finds reasoning via any of the supplied tool call ids', () => {
		const cache = new ReasoningCache();
		const model = cache.forModel('deepseek-v4-pro');

		model.remember(['call-2'], { text: 'thinking hard', textField: 'reasoning_content' });

		expect(model.lookup(['call-unknown', 'call-2'])?.text).toBe('thinking hard');
	});

	it('returns undefined for unknown tool call ids', () => {
		const cache = new ReasoningCache();
		const model = cache.forModel('deepseek-v4-pro');

		expect(model.lookup(['call-1'])).toBeUndefined();
		expect(model.lookup([])).toBeUndefined();
	});

	it('never leaks reasoning between models', () => {
		const cache = new ReasoningCache();
		cache.forModel('deepseek-v4-pro').remember(['call-1'], { text: 'thinking hard', textField: 'reasoning_content' });

		expect(cache.forModel('openai/gpt-5').lookup(['call-1'])).toBeUndefined();
	});

	it('ignores empty reasoning and empty tool call ids', () => {
		const cache = new ReasoningCache();
		const model = cache.forModel('deepseek-v4-pro');

		model.remember(['call-1'], undefined);
		model.remember([''], { text: 'thinking hard', textField: 'reasoning_content' });

		expect(model.lookup(['call-1'])).toBeUndefined();
		expect(cache.size).toBe(0);
	});

	it('evicts the oldest entries once the cap is reached', () => {
		const cache = new ReasoningCache(2);
		const model = cache.forModel('deepseek-v4-pro');

		model.remember(['call-1'], { text: 'first', textField: 'reasoning_content' });
		model.remember(['call-2'], { text: 'second', textField: 'reasoning_content' });
		model.remember(['call-3'], { text: 'third', textField: 'reasoning_content' });

		expect(cache.size).toBe(2);
		expect(model.lookup(['call-1'])).toBeUndefined();
		expect(model.lookup(['call-2'])?.text).toBe('second');
		expect(model.lookup(['call-3'])?.text).toBe('third');
	});

	it('evicts on total size, not just entry count', () => {
		const cache = new ReasoningCache(100, 20);
		const model = cache.forModel('deepseek-v4-pro');

		model.remember(['call-1'], { text: 'a'.repeat(15), textField: 'reasoning' });
		model.remember(['call-2'], { text: 'b'.repeat(15), textField: 'reasoning' });

		expect(cache.size).toBe(1);
		expect(model.lookup(['call-1'])).toBeUndefined();
		expect(model.lookup(['call-2'])?.text).toHaveLength(15);
	});

	it('counts text nested inside reasoning_details toward the budget', () => {
		const cache = new ReasoningCache();
		const model = cache.forModel('deepseek-v4-pro');

		model.remember(['call-1'], {
			text: 'abcde',
			textField: 'reasoning',
			details: [{ type: 'reasoning.text', index: 0, text: 'abcde' }]
		});

		// 5 (text) + 5 (details text) + 14 ("reasoning.text"), indexes are numeric and not charged.
		expect(cache.charCount).toBe(24);
	});

	it('keeps the newest entry even when it alone exceeds the budget', () => {
		const cache = new ReasoningCache(100, 10);
		const model = cache.forModel('deepseek-v4-pro');

		model.remember(['call-1'], { text: 'a'.repeat(500), textField: 'reasoning' });

		expect(cache.size).toBe(1);
		expect(model.lookup(['call-1'])).toBeDefined();
	});

	it('releases charged size when an entry is evicted or refreshed', () => {
		const cache = new ReasoningCache();
		const model = cache.forModel('deepseek-v4-pro');

		model.remember(['call-1'], { text: 'a'.repeat(100), textField: 'reasoning' });
		model.remember(['call-1'], { text: 'b'.repeat(10), textField: 'reasoning' });

		expect(cache.charCount).toBe(10);

		cache.clear();
		expect(cache.charCount).toBe(0);
		expect(cache.size).toBe(0);
	});

	it('reports no dialect for a model never seen producing reasoning', () => {
		const cache = new ReasoningCache();

		expect(cache.forModel('openai/gpt-5').dialect()).toBeUndefined();
	});

	it('round-trips learned dialects so a reload does not forget them', () => {
		const before = new ReasoningCache();
		before.forModel('opencode-go/deepseek-v4-pro').noteDialect('reasoning');
		before.forModel('deepseek-direct').noteDialect('reasoning_content');

		const after = new ReasoningCache();
		after.hydrateDialects(before.exportDialects());

		expect(after.forModel('opencode-go/deepseek-v4-pro').dialect()).toBe('reasoning');
		expect(after.forModel('deepseek-direct').dialect()).toBe('reasoning_content');
		expect(after.forModel('openai/gpt-5').dialect()).toBeUndefined();
	});

	it('ignores malformed persisted dialects', () => {
		const cache = new ReasoningCache();

		cache.hydrateDialects({ 'a-model': 'nonsense' as never });
		cache.hydrateDialects(undefined as never);

		expect(cache.forModel('a-model').dialect()).toBeUndefined();
	});

	it('treats a refreshed entry as most recently used', () => {
		const cache = new ReasoningCache(2);
		const model = cache.forModel('deepseek-v4-pro');

		model.remember(['call-1'], { text: 'first', textField: 'reasoning_content' });
		model.remember(['call-2'], { text: 'second', textField: 'reasoning_content' });
		model.remember(['call-1'], { text: 'first again', textField: 'reasoning_content' });
		model.remember(['call-3'], { text: 'third', textField: 'reasoning_content' });

		expect(model.lookup(['call-1'])?.text).toBe('first again');
		expect(model.lookup(['call-2'])).toBeUndefined();
	});
});
