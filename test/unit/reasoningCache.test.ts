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

	it('round-trips entries so a reload does not lose reasoning from the last few turns', () => {
		const before = new ReasoningCache();
		before.forModel('opencode-go/deepseek-v4-flash').remember(['call-1'], { text: 'x', textField: 'reasoning' });

		const after = new ReasoningCache();
		after.hydrateEntries(before.exportEntries());

		expect(after.forModel('opencode-go/deepseek-v4-flash').lookup(['call-1'])?.text).toBe('x');
	});

	it('exports only a small, most-recent slice, not the full runtime cache', () => {
		const cache = new ReasoningCache();
		const model = cache.forModel('deepseek-v4-pro');
		for (let i = 0; i < 40; i++) {
			model.remember([`call-${i}`], { text: `turn-${i}`, textField: 'reasoning' });
		}

		const exported = cache.exportEntries();

		expect(Object.keys(exported).length).toBeLessThan(cache.size);
		expect(Object.keys(exported).length).toBeLessThanOrEqual(20);
		// The most recent turn must be the one preserved, not an arbitrary or oldest one.
		const after = new ReasoningCache();
		after.hydrateEntries(exported);
		expect(after.forModel('deepseek-v4-pro').lookup(['call-39'])?.text).toBe('turn-39');
		expect(after.forModel('deepseek-v4-pro').lookup(['call-0'])).toBeUndefined();
	});

	it('caps the persisted export by characters as well as by count', () => {
		const cache = new ReasoningCache();
		const model = cache.forModel('deepseek-v4-pro');
		for (let i = 0; i < 10; i++) {
			model.remember([`call-${i}`], { text: 'x'.repeat(50_000), textField: 'reasoning' });
		}

		const exported = cache.exportEntries();
		const totalExportedChars = Object.values(exported).reduce((sum, r) => sum + r.text.length, 0);

		expect(totalExportedChars).toBeLessThanOrEqual(200_000);
	});

	it('still enforces the runtime budget on hydrated entries', () => {
		const cache = new ReasoningCache(2);

		// hydrateEntries expects most-recent-first input, matching exportEntries' actual output order.
		// Keys join model id and tool call id with a NUL separator, matching cacheKey's own format.
		cache.hydrateEntries({
			[`model\u0000call-3`]: { text: 'third', textField: 'reasoning' },
			[`model\u0000call-2`]: { text: 'second', textField: 'reasoning' },
			[`model\u0000call-1`]: { text: 'first', textField: 'reasoning' }
		});

		expect(cache.size).toBeLessThanOrEqual(2);
		expect(cache.forModel('model').lookup(['call-3'])?.text).toBe('third');
	});

	it('tolerates an empty or missing persisted export', () => {
		const cache = new ReasoningCache();

		cache.hydrateEntries({});
		cache.hydrateEntries(undefined as never);

		expect(cache.size).toBe(0);
	});

	it('never evicts the entry just written, across a long realistic session', () => {
		// Reproduces the shape of a real 400+ message DeepSeek session: default budget (200 entries /
		// 2M chars), turns 100–20,000 reasoningChars (doubled by reasoning_details duplication, per
		// the "counts text nested inside reasoning_details" test above), and the occasional
		// multi-tool-call turn — to check the suspicion that the cache "spills over" and loses a
		// turn's own reasoning before the very next request can look it up.
		const cache = new ReasoningCache();
		const model = cache.forModel('opencode-go/deepseek-v4-pro');

		for (let turn = 0; turn < 500; turn++) {
			const reasoningChars = 100 + ((turn * 137) % 19900); // spread across the observed range
			const toolCallIds = turn % 7 === 0 ? [`call-${turn}-a`, `call-${turn}-b`] : [`call-${turn}`];
			const text = 'x'.repeat(reasoningChars);

			model.remember(toolCallIds, {
				text,
				textField: 'reasoning',
				details: [{ type: 'reasoning.text', index: 0, text }]
			});

			// The critical assertion: whatever was *just* written must be immediately readable, as it
			// would be by the very next request in a real conversation.
			for (const id of toolCallIds) {
				expect(model.lookup([id])?.text).toHaveLength(reasoningChars);
			}
		}

		expect(cache.size).toBeLessThanOrEqual(200);
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
