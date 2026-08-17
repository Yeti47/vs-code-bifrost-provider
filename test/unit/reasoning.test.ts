import { describe, expect, it } from 'vitest';
import { ReasoningAccumulator, applyReasoning } from '../../src/reasoning';
import { OpenAIMessage } from '../../src/types';

function assistant(): OpenAIMessage {
	return { role: 'assistant', content: null };
}

describe('ReasoningAccumulator', () => {
	it('captures nothing from a stream without reasoning', () => {
		const acc = new ReasoningAccumulator();

		expect(acc.add({ content: 'hello' })).toBe('');
		expect(acc.add(undefined)).toBe('');
		expect(acc.snapshot()).toBeUndefined();
		expect(acc.describeDetails()).toBe('none');
	});

	it('accumulates DeepSeek-dialect reasoning_content', () => {
		const acc = new ReasoningAccumulator();
		acc.add({ reasoning_content: 'let ' });
		acc.add({ reasoning_content: 'me think' });

		expect(acc.snapshot()).toEqual({ text: 'let me think', textField: 'reasoning_content', details: undefined });
	});

	it('accumulates OpenRouter-dialect reasoning', () => {
		const acc = new ReasoningAccumulator();
		acc.add({ reasoning: 'let ' });
		acc.add({ reasoning: 'me think' });

		expect(acc.snapshot()?.textField).toBe('reasoning');
		expect(acc.snapshot()?.text).toBe('let me think');
	});

	it('returns each fragment so it can be streamed onward', () => {
		const acc = new ReasoningAccumulator();

		expect(acc.add({ reasoning: 'first' })).toBe('first');
		expect(acc.add({ reasoning: 'second' })).toBe('second');
	});

	it('merges reasoning_details fragments that share an index', () => {
		const acc = new ReasoningAccumulator();
		acc.add({ reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'let ' }] });
		acc.add({ reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'me think' }] });
		acc.add({ reasoning_details: [{ type: 'reasoning.text', index: 0, signature: 'sig-1' }] });

		expect(acc.snapshot()?.details).toEqual([
			{ type: 'reasoning.text', index: 0, text: 'let me think', signature: 'sig-1' }
		]);
	});

	it('keeps separate indexes apart and emits them in order', () => {
		const acc = new ReasoningAccumulator();
		acc.add({ reasoning_details: [{ type: 'reasoning.text', index: 1, text: 'second' }] });
		acc.add({ reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'first' }] });

		expect(acc.snapshot()?.details?.map((d) => d.text)).toEqual(['first', 'second']);
	});

	it('does not concatenate discriminator fields repeated on every fragment', () => {
		const acc = new ReasoningAccumulator();
		acc.add({ reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'a' }] });
		acc.add({ reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'b' }] });

		expect(acc.snapshot()?.details?.[0].type).toBe('reasoning.text');
	});

	it('gives unindexed details distinct slots rather than merging them', () => {
		const acc = new ReasoningAccumulator();
		acc.add({ reasoning_details: [{ type: 'reasoning.summary', text: 'one' }] });
		acc.add({ reasoning_details: [{ type: 'reasoning.summary', text: 'two' }] });

		expect(acc.snapshot()?.details?.map((d) => d.text)).toEqual(['one', 'two']);
	});

	it('summarises detail structure without leaking reasoning text', () => {
		const acc = new ReasoningAccumulator();
		acc.add({ reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'secret reasoning' }] });

		const described = acc.describeDetails();
		expect(described).toBe('1[reasoning.text:index|text|type]');
		expect(described).not.toContain('secret');
	});

	it('captures details even when no text field was streamed', () => {
		const acc = new ReasoningAccumulator();
		acc.add({ reasoning_details: [{ type: 'reasoning.encrypted', index: 0, data: 'x' }] });

		expect(acc.snapshot()?.text).toBe('');
		expect(acc.snapshot()?.details).toHaveLength(1);
	});
});

describe('applyReasoning', () => {
	it('writes the text under the dialect it was captured in', () => {
		const message = assistant();
		applyReasoning(message, { text: 'let me think', textField: 'reasoning' });

		expect(message.reasoning).toBe('let me think');
		expect(message).not.toHaveProperty('reasoning_content');
	});

	it('replays reasoning_details verbatim alongside the text', () => {
		const message = assistant();
		const details = [{ type: 'reasoning.text', index: 0, text: 'x', signature: 'sig' }];
		applyReasoning(message, { text: 'x', textField: 'reasoning_content', details });

		expect(message.reasoning_content).toBe('x');
		expect(message.reasoning_details).toEqual(details);
	});

	it('sets no field at all for empty reasoning', () => {
		const message = assistant();
		applyReasoning(message, { text: '', textField: 'reasoning', details: [] });

		expect(message).not.toHaveProperty('reasoning');
		expect(message).not.toHaveProperty('reasoning_details');
	});
});
