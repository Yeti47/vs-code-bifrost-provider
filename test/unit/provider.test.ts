import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { __outputChannelLines, __resetMockVscodeState, __setConfigValue, __setThinkingPartAvailable } from '../mocks/vscode';
import { isThinkingPart, thinkingPartText } from '../../src/thinking';

vi.mock('../../src/bifrostClient', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/bifrostClient')>();
	return { ...actual, fetchModels: vi.fn(), streamChatCompletion: vi.fn() };
});

import { fetchModels, streamChatCompletion } from '../../src/bifrostClient';
import { BifrostChatModelProvider } from '../../src/provider';
import { BifrostModel, OpenAIStreamChunk } from '../../src/types';

function fakeContext(secrets: Record<string, string> = {}) {
	const store = new Map(Object.entries(secrets));
	return {
		secrets: {
			get: vi.fn(async (key: string) => store.get(key)),
			store: vi.fn(async (key: string, value: string) => {
				store.set(key, value);
			})
		},
		globalStorageUri: vscode.Uri.file('/fake/global-storage')
	} as unknown as import('vscode').ExtensionContext;
}

function fakeToken(): import('vscode').CancellationToken {
	return new vscode.CancellationTokenSource().token;
}

function configureConnection(apiKey = 'test-key') {
	__setConfigValue('bifrost', 'baseUrl', 'https://bifrost.example.com');
	return fakeContext({ 'bifrost.apiKey': apiKey });
}

async function* streamOf(chunks: OpenAIStreamChunk[]): AsyncGenerator<OpenAIStreamChunk> {
	for (const chunk of chunks) {
		yield chunk;
	}
}

describe('BifrostChatModelProvider.provideLanguageModelChatInformation', () => {
	beforeEach(() => {
		__resetMockVscodeState();
		vi.mocked(fetchModels).mockReset();
		vi.mocked(streamChatCompletion).mockReset();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('network disabled in unit tests');
			})
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns no models when unconfigured and called silently', async () => {
		const provider = new BifrostChatModelProvider(fakeContext());

		const result = await provider.provideLanguageModelChatInformation({ silent: true } as never, fakeToken());

		expect(result).toEqual([]);
		expect(fetchModels).not.toHaveBeenCalled();
	});

	it('prompts for a connection when unconfigured and not silent, returning [] if cancelled', async () => {
		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);
		const provider = new BifrostChatModelProvider(fakeContext());

		const result = await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(result).toEqual([]);
	});

	it('maps a model that reports max_input_tokens directly', async () => {
		const models: BifrostModel[] = [
			{ id: 'openrouter/gpt-4', name: 'GPT-4', max_input_tokens: 8000, supported_parameters: ['tools'] }
		];
		vi.mocked(fetchModels).mockResolvedValueOnce(models);
		const provider = new BifrostChatModelProvider(configureConnection());

		const [info] = await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(info).toMatchObject({
			id: 'openrouter/gpt-4',
			family: 'openrouter',
			name: 'openrouter: GPT-4',
			maxInputTokens: 8000,
			maxOutputTokens: 4096,
			capabilities: { toolCalling: true, imageInput: false }
		});
	});

	it('falls back to context_length when max_input_tokens is absent', async () => {
		const models: BifrostModel[] = [{ id: 'ollama/llama3.1', context_length: 32000 }];
		vi.mocked(fetchModels).mockResolvedValueOnce(models);
		const provider = new BifrostChatModelProvider(configureConnection());

		const [info] = await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(info.maxInputTokens).toBe(32000);
	});

	it('assumes tool calling is supported when supported_parameters is absent', async () => {
		const models: BifrostModel[] = [{ id: 'custom/model', max_input_tokens: 4096 }];
		vi.mocked(fetchModels).mockResolvedValueOnce(models);
		const provider = new BifrostChatModelProvider(configureConnection());

		const [info] = await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(info.capabilities?.toolCalling).toBe(true);
	});

	it('reports no tool calling when supported_parameters excludes tools', async () => {
		const models: BifrostModel[] = [{ id: 'custom/model', max_input_tokens: 4096, supported_parameters: ['temperature'] }];
		vi.mocked(fetchModels).mockResolvedValueOnce(models);
		const provider = new BifrostChatModelProvider(configureConnection());

		const [info] = await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(info.capabilities?.toolCalling).toBe(false);
	});

	it('reports image input when the architecture lists an image modality', async () => {
		const models: BifrostModel[] = [
			{ id: 'custom/vision', max_input_tokens: 4096, architecture: { input_modalities: ['text', 'image'] } }
		];
		vi.mocked(fetchModels).mockResolvedValueOnce(models);
		const provider = new BifrostChatModelProvider(configureConnection());

		const [info] = await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(info.capabilities?.imageInput).toBe(true);
	});

	it('cross-references context size from a sibling model with the same base name', async () => {
		const models: BifrostModel[] = [
			{ id: 'openrouter/kimi-k3', max_input_tokens: 32000 },
			{ id: 'opencode-go/kimi-k3' }
		];
		vi.mocked(fetchModels).mockResolvedValueOnce(models);
		const provider = new BifrostChatModelProvider(configureConnection());

		const infos = await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());
		const sibling = infos.find((i) => i.id === 'opencode-go/kimi-k3')!;

		expect(sibling.maxInputTokens).toBe(32000);
		expect(sibling.tooltip).toContain('cross-referenced from openrouter');
	});

	it('falls back to a configured override when nothing else resolves the context size', async () => {
		__setConfigValue('bifrost', 'contextSizeOverrides', { custom: 16000 });
		const models: BifrostModel[] = [{ id: 'custom/model' }];
		vi.mocked(fetchModels).mockResolvedValueOnce(models);
		const provider = new BifrostChatModelProvider(configureConnection());

		const [info] = await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(info.maxInputTokens).toBe(16000);
	});

	it('falls back to the hardcoded default when nothing resolves the context size', async () => {
		const models: BifrostModel[] = [{ id: 'custom/model' }];
		vi.mocked(fetchModels).mockResolvedValueOnce(models);
		const provider = new BifrostChatModelProvider(configureConnection());

		const [info] = await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(info.maxInputTokens).toBe(4096);
		expect(info.tooltip).toContain('context size unknown');
	});

	it('caches results and does not re-fetch within the TTL', async () => {
		vi.mocked(fetchModels).mockResolvedValue([{ id: 'a', max_input_tokens: 1000 }]);
		const provider = new BifrostChatModelProvider(configureConnection());

		await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());
		await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(fetchModels).toHaveBeenCalledTimes(1);
	});

	it('re-fetches after invalidateCache()', async () => {
		vi.mocked(fetchModels).mockResolvedValue([{ id: 'a', max_input_tokens: 1000 }]);
		const provider = new BifrostChatModelProvider(configureConnection());

		await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());
		provider.invalidateCache();
		await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(fetchModels).toHaveBeenCalledTimes(2);
	});

	it('shows a specific error for an auth failure and offers to reconfigure', async () => {
		const { BifrostApiError } = await import('../../src/bifrostClient');
		vi.mocked(fetchModels).mockRejectedValueOnce(new BifrostApiError(401, 'nope'));
		vi.mocked(vscode.window.showErrorMessage).mockResolvedValueOnce('Reconfigure');
		const provider = new BifrostChatModelProvider(configureConnection());

		const result = await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(result).toEqual([]);
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining('check that your virtual key is correct'),
			'Reconfigure'
		);
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith('bifrost.manage');
	});

	it('suppresses the error dialog on a silent discovery failure', async () => {
		vi.mocked(fetchModels).mockRejectedValueOnce(new Error('boom'));
		const provider = new BifrostChatModelProvider(configureConnection());

		const result = await provider.provideLanguageModelChatInformation({ silent: true } as never, fakeToken());

		expect(result).toEqual([]);
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
	});
});

describe('BifrostChatModelProvider.provideLanguageModelChatResponse', () => {
	beforeEach(() => {
		__resetMockVscodeState();
		vi.mocked(fetchModels).mockReset();
		vi.mocked(streamChatCompletion).mockReset();
	});

	const modelInfo = { id: 'custom/model' } as unknown as import('vscode').LanguageModelChatInformation;
	const options = { toolMode: vscode.LanguageModelChatToolMode.Auto } as unknown as import('vscode').ProvideLanguageModelChatResponseOptions;

	it('throws if bifrost is not configured', async () => {
		const provider = new BifrostChatModelProvider(fakeContext());
		const progress = { report: vi.fn() };

		await expect(
			provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken())
		).rejects.toThrow('Bifrost is not configured');
	});

	it('reports streamed text content', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([{ choices: [{ delta: { content: 'Hel' } }] }, { choices: [{ delta: { content: 'lo' } }] }])
		);
		const provider = new BifrostChatModelProvider(configureConnection());
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		const reported = progress.report.mock.calls.map((c) => c[0]);
		expect(reported).toHaveLength(2);
		expect(reported[0]).toBeInstanceOf(vscode.LanguageModelTextPart);
		expect((reported[0] as vscode.LanguageModelTextPart).value).toBe('Hel');
		expect((reported[1] as vscode.LanguageModelTextPart).value).toBe('lo');
	});

	it('accumulates tool call deltas across chunks and emits one tool call part on finish', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([
				{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'sea' } }] } }] },
				{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'rch', arguments: '{"q":' } }] } }] },
				{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] },
				{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
			])
		);
		const provider = new BifrostChatModelProvider(configureConnection());
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		expect(progress.report).toHaveBeenCalledTimes(1);
		const part = progress.report.mock.calls[0][0] as vscode.LanguageModelToolCallPart;
		expect(part).toBeInstanceOf(vscode.LanguageModelToolCallPart);
		expect(part.callId).toBe('call-1');
		expect(part.name).toBe('search');
		expect(part.input).toEqual({ q: 'x' });
	});

	it('falls back to an empty object for malformed tool call arguments', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([
				{
					choices: [
						{
							delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'search', arguments: '{not json' } }] },
							finish_reason: 'tool_calls'
						}
					]
				}
			])
		);
		const provider = new BifrostChatModelProvider(configureConnection());
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		const part = progress.report.mock.calls[0][0] as vscode.LanguageModelToolCallPart;
		expect(part.input).toEqual({});
	});

	it('ignores chunks with no choices', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(streamOf([{ choices: [] }, { choices: undefined }]));
		const provider = new BifrostChatModelProvider(configureConnection());
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		expect(progress.report).not.toHaveBeenCalled();
	});

	it('flushes buffered tool calls when the turn ends with finish_reason "stop"', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([
				{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'search', arguments: '{}' } }] } }] },
				{ choices: [{ delta: {}, finish_reason: 'stop' }] }
			])
		);
		const provider = new BifrostChatModelProvider(configureConnection());
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		const part = progress.report.mock.calls[0][0] as vscode.LanguageModelToolCallPart;
		expect(part).toBeInstanceOf(vscode.LanguageModelToolCallPart);
		expect(part.callId).toBe('call-1');
	});

	it('flushes buffered tool calls when the stream ends without any finish_reason', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([
				{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'search', arguments: '{}' } }] } }] }
			])
		);
		const provider = new BifrostChatModelProvider(configureConnection());
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		expect(progress.report).toHaveBeenCalledTimes(1);
		expect((progress.report.mock.calls[0][0] as vscode.LanguageModelToolCallPart).callId).toBe('call-1');
	});

	it('does not report tool calls twice when finish_reason already flushed them', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([
				{
					choices: [
						{
							delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'search', arguments: '{}' } }] },
							finish_reason: 'tool_calls'
						}
					]
				}
			])
		);
		const provider = new BifrostChatModelProvider(configureConnection());
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		expect(progress.report).toHaveBeenCalledTimes(1);
	});

	it('streams reasoning_content deltas as thinking parts', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([
				{ choices: [{ delta: { reasoning_content: 'let me ' } }] },
				{ choices: [{ delta: { reasoning_content: 'think' } }] },
				{ choices: [{ delta: { content: 'answer' } }] }
			])
		);
		const provider = new BifrostChatModelProvider(configureConnection());
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		const reported = progress.report.mock.calls.map((c) => c[0]);
		expect(reported).toHaveLength(3);
		expect(isThinkingPart(reported[0])).toBe(true);
		expect(thinkingPartText(reported[0] as never)).toBe('let me ');
		expect(thinkingPartText(reported[1] as never)).toBe('think');
		expect(reported[2]).toBeInstanceOf(vscode.LanguageModelTextPart);
	});

	it('still streams text when the host has no thinking part API', async () => {
		__setThinkingPartAvailable(false);
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([{ choices: [{ delta: { reasoning_content: 'dropped' } }] }, { choices: [{ delta: { content: 'answer' } }] }])
		);
		const provider = new BifrostChatModelProvider(configureConnection());
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		const reported = progress.report.mock.calls.map((c) => c[0]);
		expect(reported).toHaveLength(1);
		expect(reported[0]).toBeInstanceOf(vscode.LanguageModelTextPart);
	});

	it('replays reasoning on the next request when the client drops the thinking part', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([
				{ choices: [{ delta: { reasoning_content: 'let me think' } }] },
				{
					choices: [
						{
							delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'search', arguments: '{}' } }] },
							finish_reason: 'tool_calls'
						}
					]
				}
			])
		);
		const provider = new BifrostChatModelProvider(configureConnection());
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		// Second turn: history carries the tool call back, but with the thinking part stripped out.
		vi.mocked(streamChatCompletion).mockReturnValueOnce(streamOf([]));
		const history = [
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelToolCallPart('call-1', 'search', {})]
			}
		] as unknown as readonly import('vscode').LanguageModelChatRequestMessage[];

		await provider.provideLanguageModelChatResponse(modelInfo, history, options, progress as never, fakeToken());

		const request = vi.mocked(streamChatCompletion).mock.calls[1][1];
		expect(request.messages[0].reasoning_content).toBe('let me think');
	});

	it('logs which path carried the reasoning', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([
				{ choices: [{ delta: { reasoning_content: 'let me think' } }] },
				{
					choices: [
						{
							delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'search', arguments: '{}' } }] },
							finish_reason: 'tool_calls'
						}
					]
				}
			])
		);
		const provider = new BifrostChatModelProvider(configureConnection());
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		const response = __outputChannelLines.find((line) => line.includes('response '));
		expect(response).toContain('reasoningChars=12');
		expect(response).toContain('thinkingPartsReported=1');
		expect(response).toContain('toolCalls=1');
		expect(response).toContain('finishReasons=tool_calls');
		expect(response).toContain('deltaKeys=reasoning_content,tool_calls');
	});

	it('captures reasoning streamed under the OpenRouter-dialect "reasoning" field', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([
				{ choices: [{ delta: { reasoning: 'let me ' } }] },
				{ choices: [{ delta: { reasoning: 'think' } }] },
				{ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }
			])
		);
		const provider = new BifrostChatModelProvider(configureConnection());
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		const reported = progress.report.mock.calls.map((c) => c[0]);
		expect(reported.filter((part) => isThinkingPart(part))).toHaveLength(2);

		const response = __outputChannelLines.find((line) => line.includes('response '));
		expect(response).toContain('reasoningChars=12');
		expect(response).toContain('reasoningField=reasoning');
		expect(response).toContain('deltaKeys=content,reasoning');
	});

	it('replays OpenRouter-dialect reasoning and reasoning_details on the next request', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([
				{
					choices: [
						{
							delta: {
								reasoning: 'let me think',
								reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'let me think' }]
							}
						}
					]
				},
				{
					choices: [
						{
							delta: {
								reasoning_details: [{ type: 'reasoning.text', index: 0, signature: 'sig-1' }],
								tool_calls: [{ index: 0, id: 'call-1', function: { name: 'search', arguments: '{}' } }]
							},
							finish_reason: 'tool_calls'
						}
					]
				}
			])
		);
		const provider = new BifrostChatModelProvider(configureConnection());
		const progress = { report: vi.fn() };
		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		vi.mocked(streamChatCompletion).mockReturnValueOnce(streamOf([]));
		const history = [
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelToolCallPart('call-1', 'search', {})]
			}
		] as unknown as readonly import('vscode').LanguageModelChatRequestMessage[];

		await provider.provideLanguageModelChatResponse(modelInfo, history, options, progress as never, fakeToken());

		// The diagnostics counter must notice reasoning sent under any dialect, not just DeepSeek's.
		const requests = __outputChannelLines.filter((line) => line.includes('request '));
		expect(requests[1]).toContain('sentReasoning=1');

		const replayed = vi.mocked(streamChatCompletion).mock.calls[1][1].messages[0];
		expect(replayed.reasoning).toBe('let me think');
		expect(replayed).not.toHaveProperty('reasoning_content');
		// Fragments sharing an index merge into one entry, with the late-arriving signature preserved.
		expect(replayed.reasoning_details).toEqual([
			{ type: 'reasoning.text', index: 0, text: 'let me think', signature: 'sig-1' }
		]);
	});

	it('reports in diagnostics when the cache, not the client, supplied the reasoning', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([
				{ choices: [{ delta: { reasoning_content: 'let me think' } }] },
				{
					choices: [
						{
							delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'search', arguments: '{}' } }] },
							finish_reason: 'tool_calls'
						}
					]
				}
			])
		);
		const provider = new BifrostChatModelProvider(configureConnection());
		const progress = { report: vi.fn() };
		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		vi.mocked(streamChatCompletion).mockReturnValueOnce(streamOf([]));
		const history = [
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelToolCallPart('call-1', 'search', {})]
			}
		] as unknown as readonly import('vscode').LanguageModelChatRequestMessage[];

		await provider.provideLanguageModelChatResponse(modelInfo, history, options, progress as never, fakeToken());

		const requests = __outputChannelLines.filter((line) => line.includes('request '));
		expect(requests[1]).toContain('historyThinkingParts=0');
		expect(requests[1]).toContain('sentReasoning=1');
		expect(requests[1]).toContain('thinkingPartApi=available');
	});

	it('sends no X-Bifrost-Route header when routingTargets is unconfigured', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(streamOf([]));
		const provider = new BifrostChatModelProvider(configureConnection());
		const progress = { report: vi.fn() };
		const history = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart('hello')]
			}
		] as unknown as readonly import('vscode').LanguageModelChatRequestMessage[];

		await provider.provideLanguageModelChatResponse(modelInfo, history, options, progress as never, fakeToken());

		expect(vi.mocked(streamChatCompletion).mock.calls[0][3]).toBeUndefined();
	});

	it('picks a routing target from configured weights and keeps it stable across turns', async () => {
		__setConfigValue('bifrost', 'routingTargets', { a: 1, b: 1 });
		vi.mocked(streamChatCompletion).mockReturnValue(streamOf([]));
		const provider = new BifrostChatModelProvider(configureConnection());
		const progress = { report: vi.fn() };
		const history = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart('the same first message every turn')]
			}
		] as unknown as readonly import('vscode').LanguageModelChatRequestMessage[];

		await provider.provideLanguageModelChatResponse(modelInfo, history, options, progress as never, fakeToken());
		await provider.provideLanguageModelChatResponse(modelInfo, history, options, progress as never, fakeToken());

		const first = vi.mocked(streamChatCompletion).mock.calls[0][3];
		const second = vi.mocked(streamChatCompletion).mock.calls[1][3];
		expect(first).toBeDefined();
		expect(['a', 'b']).toContain(first);
		expect(second).toBe(first);
	});

	it('derives the routing target from the first message, not a constant', async () => {
		// Any two individual conversations could legally collide onto the same label (that's just a
		// hash collision, not a bug), so this checks the wiring by sampling many distinct openers:
		// if the identity were accidentally constant — e.g. always hashing "" — every one of them
		// would land on the same label instead of spreading across at least a couple.
		__setConfigValue('bifrost', 'routingTargets', { a: 1, b: 1, c: 1, d: 1, e: 1 });
		vi.mocked(streamChatCompletion).mockReturnValue(streamOf([]));
		const provider = new BifrostChatModelProvider(configureConnection());
		const progress = { report: vi.fn() };

		const seenTargets = new Set<unknown>();
		for (let i = 0; i < 20; i++) {
			const history = [
				{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart(`opener number ${i}`)] }
			] as unknown as readonly import('vscode').LanguageModelChatRequestMessage[];
			await provider.provideLanguageModelChatResponse(modelInfo, history, options, progress as never, fakeToken());
			seenTargets.add(vi.mocked(streamChatCompletion).mock.calls[i][3]);
		}

		expect(seenTargets.size).toBeGreaterThan(1);
	});

	it('never replays one model\'s reasoning to a different model', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([
				{ choices: [{ delta: { reasoning_content: 'let me think' } }] },
				{
					choices: [
						{
							delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'search', arguments: '{}' } }] },
							finish_reason: 'tool_calls'
						}
					]
				}
			])
		);
		const provider = new BifrostChatModelProvider(configureConnection());
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		vi.mocked(streamChatCompletion).mockReturnValueOnce(streamOf([]));
		const otherModel = { id: 'openai/gpt-5' } as unknown as import('vscode').LanguageModelChatInformation;
		const history = [
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelToolCallPart('call-1', 'search', {})]
			}
		] as unknown as readonly import('vscode').LanguageModelChatRequestMessage[];

		await provider.provideLanguageModelChatResponse(otherModel, history, options, progress as never, fakeToken());

		const request = vi.mocked(streamChatCompletion).mock.calls[1][1];
		expect(request.messages[0]).not.toHaveProperty('reasoning_content');
	});
});

describe('BifrostChatModelProvider.provideTokenCount', () => {
	it('estimates token count from a plain string', async () => {
		const provider = new BifrostChatModelProvider(fakeContext());

		const count = await provider.provideTokenCount(
			{} as never,
			'12345678',
			fakeToken()
		);

		expect(count).toBe(2);
	});

	it('rounds up partial estimates', async () => {
		const provider = new BifrostChatModelProvider(fakeContext());

		const count = await provider.provideTokenCount({} as never, '123', fakeToken());

		expect(count).toBe(1);
	});

	it('estimates token count from a chat message by extracting its plain text', async () => {
		const provider = new BifrostChatModelProvider(fakeContext());
		const message = {
			role: vscode.LanguageModelChatMessageRole.User,
			content: [new vscode.LanguageModelTextPart('12345678')]
		} as unknown as import('vscode').LanguageModelChatRequestMessage;

		const count = await provider.provideTokenCount({} as never, message, fakeToken());

		expect(count).toBe(2);
	});
});
