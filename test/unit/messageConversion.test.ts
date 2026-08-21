import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
	extractPlainText,
	toOpenAIMessages,
	toOpenAITools,
	toolModeToChoice
} from '../../src/messageConversion';

function userMessage(content: unknown[], name?: string) {
	return { role: vscode.LanguageModelChatMessageRole.User, content, name } as unknown as import('vscode').LanguageModelChatRequestMessage;
}

function assistantMessage(content: unknown[]) {
	return { role: vscode.LanguageModelChatMessageRole.Assistant, content } as unknown as import('vscode').LanguageModelChatRequestMessage;
}

describe('toOpenAIMessages', () => {
	it('converts an assistant text-only message', () => {
		const result = toOpenAIMessages([assistantMessage([new vscode.LanguageModelTextPart('hello')])]);

		expect(result).toEqual([{ role: 'assistant', content: 'hello' }]);
	});

	it('joins multiple assistant text parts', () => {
		const result = toOpenAIMessages([
			assistantMessage([new vscode.LanguageModelTextPart('hello '), new vscode.LanguageModelTextPart('world')])
		]);

		expect(result).toEqual([{ role: 'assistant', content: 'hello world' }]);
	});

	it('sets assistant content to null when there is no text, and includes tool_calls', () => {
		const result = toOpenAIMessages([
			assistantMessage([new vscode.LanguageModelToolCallPart('call-1', 'search', { q: 'x' })])
		]);

		expect(result).toEqual([
			{
				role: 'assistant',
				content: null,
				tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }]
			}
		]);
	});

	it('combines text and tool calls on a single assistant message', () => {
		const result = toOpenAIMessages([
			assistantMessage([
				new vscode.LanguageModelTextPart('thinking...'),
				new vscode.LanguageModelToolCallPart('call-1', 'search', {})
			])
		]);

		expect(result[0]).toMatchObject({ role: 'assistant', content: 'thinking...' });
		expect(result[0].tool_calls).toHaveLength(1);
	});

	it('collapses a single text part user message into a plain string content', () => {
		const result = toOpenAIMessages([userMessage([new vscode.LanguageModelTextPart('hi there')], 'alice')]);

		expect(result).toEqual([{ role: 'user', content: 'hi there', name: 'alice' }]);
	});

	it('keeps multi-part user content (text + image) as a content-part array', () => {
		const result = toOpenAIMessages([
			userMessage([
				new vscode.LanguageModelTextPart('look at this'),
				new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png')
			])
		]);

		expect(result).toHaveLength(1);
		expect(result[0].role).toBe('user');
		expect(Array.isArray(result[0].content)).toBe(true);
		const parts = result[0].content as Array<{ type: string }>;
		expect(parts[0]).toEqual({ type: 'text', text: 'look at this' });
		expect(parts[1].type).toBe('image_url');
	});

	it('base64-encodes image data parts as a data: URL', () => {
		const result = toOpenAIMessages([
			userMessage([new vscode.LanguageModelDataPart(new Uint8Array([72, 105]), 'image/png')])
		]);

		const parts = result[0].content as Array<{ type: string; image_url?: { url: string } }>;
		expect(parts[0]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from([72, 105]).toString('base64')}` } });
	});

	it('ignores non-image data parts', () => {
		const result = toOpenAIMessages([
			userMessage([
				new vscode.LanguageModelTextPart('text'),
				new vscode.LanguageModelDataPart(new Uint8Array([1]), 'application/octet-stream')
			])
		]);

		expect(result).toEqual([{ role: 'user', content: 'text', name: undefined }]);
	});

	it('emits a separate tool message for tool result parts', () => {
		const result = toOpenAIMessages([
			userMessage([
				new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('42')]),
				new vscode.LanguageModelTextPart('and then?')
			])
		]);

		expect(result).toEqual([
			{ role: 'tool', tool_call_id: 'call-1', content: '42' },
			{ role: 'user', content: 'and then?', name: undefined }
		]);
	});

	it('joins multiple text parts inside a single tool result', () => {
		const result = toOpenAIMessages([
			userMessage([
				new vscode.LanguageModelToolResultPart('call-1', [
					new vscode.LanguageModelTextPart('line1'),
					new vscode.LanguageModelTextPart('line2')
				])
			])
		]);

		expect(result).toEqual([{ role: 'tool', tool_call_id: 'call-1', content: 'line1\nline2' }]);
	});

	it('produces no user message when content is empty', () => {
		const result = toOpenAIMessages([userMessage([])]);

		expect(result).toEqual([]);
	});

	it('processes multiple input messages in order', () => {
		const result = toOpenAIMessages([
			userMessage([new vscode.LanguageModelTextPart('hi')]),
			assistantMessage([new vscode.LanguageModelTextPart('hello')])
		]);

		expect(result.map((m) => m.role)).toEqual(['user', 'assistant']);
	});
});

describe('toOpenAITools', () => {
	it('returns undefined when there are no tools', () => {
		expect(toOpenAITools(undefined)).toBeUndefined();
		expect(toOpenAITools([])).toBeUndefined();
	});

	it('maps tools to the OpenAI function-tool shape', () => {
		const tools = [{ name: 'search', description: 'search the web', inputSchema: { type: 'object' } }];

		expect(toOpenAITools(tools as never)).toEqual([
			{ type: 'function', function: { name: 'search', description: 'search the web', parameters: { type: 'object' } } }
		]);
	});
});

describe('toolModeToChoice', () => {
	it('maps Required to "required"', () => {
		expect(toolModeToChoice(vscode.LanguageModelChatToolMode.Required)).toBe('required');
	});

	it('maps Auto to "auto"', () => {
		expect(toolModeToChoice(vscode.LanguageModelChatToolMode.Auto)).toBe('auto');
	});
});

describe('extractPlainText', () => {
	it('joins only the text parts of a message', () => {
		const message = userMessage([
			new vscode.LanguageModelTextPart('a'),
			new vscode.LanguageModelDataPart(new Uint8Array(), 'image/png'),
			new vscode.LanguageModelTextPart('b')
		]);

		expect(extractPlainText(message)).toBe('ab');
	});

	it('returns an empty string for a message with no text parts', () => {
		expect(extractPlainText(userMessage([]))).toBe('');
	});
});
