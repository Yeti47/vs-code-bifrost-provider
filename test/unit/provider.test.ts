import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { __resetMockVscodeState, __setConfigValue, __setThinkingPartAvailable } from '../mocks/vscode';

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

const noProfile = { getActiveProfile: () => undefined };

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
		const provider = new BifrostChatModelProvider(fakeContext(), noProfile);

		const result = await provider.provideLanguageModelChatInformation({ silent: true } as never, fakeToken());

		expect(result).toEqual([]);
		expect(fetchModels).not.toHaveBeenCalled();
	});

	it('prompts for a connection when unconfigured and not silent, returning [] if cancelled', async () => {
		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);
		const provider = new BifrostChatModelProvider(fakeContext(), noProfile);

		const result = await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(result).toEqual([]);
	});

	it('maps a model that reports max_input_tokens directly', async () => {
		const models: BifrostModel[] = [
			{ id: 'openrouter/gpt-4', name: 'GPT-4', max_input_tokens: 8000, supported_parameters: ['tools'] }
		];
		vi.mocked(fetchModels).mockResolvedValueOnce(models);
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);

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
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);

		const [info] = await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(info.maxInputTokens).toBe(32000);
	});

	it('assumes tool calling is supported when supported_parameters is absent', async () => {
		const models: BifrostModel[] = [{ id: 'custom/model', max_input_tokens: 4096 }];
		vi.mocked(fetchModels).mockResolvedValueOnce(models);
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);

		const [info] = await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(info.capabilities?.toolCalling).toBe(true);
	});

	it('reports no tool calling when supported_parameters excludes tools', async () => {
		const models: BifrostModel[] = [{ id: 'custom/model', max_input_tokens: 4096, supported_parameters: ['temperature'] }];
		vi.mocked(fetchModels).mockResolvedValueOnce(models);
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);

		const [info] = await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(info.capabilities?.toolCalling).toBe(false);
	});

	it('reports image input when the architecture lists an image modality', async () => {
		const models: BifrostModel[] = [
			{ id: 'custom/vision', max_input_tokens: 4096, architecture: { input_modalities: ['text', 'image'] } }
		];
		vi.mocked(fetchModels).mockResolvedValueOnce(models);
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);

		const [info] = await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(info.capabilities?.imageInput).toBe(true);
	});

	it('cross-references context size from a sibling model with the same base name', async () => {
		const models: BifrostModel[] = [
			{ id: 'openrouter/kimi-k3', max_input_tokens: 32000 },
			{ id: 'opencode-go/kimi-k3' }
		];
		vi.mocked(fetchModels).mockResolvedValueOnce(models);
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);

		const infos = await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());
		const sibling = infos.find((i) => i.id === 'opencode-go/kimi-k3')!;

		expect(sibling.maxInputTokens).toBe(32000);
		expect(sibling.tooltip).toContain('cross-referenced from openrouter');
	});

	it('falls back to a configured override when nothing else resolves the context size', async () => {
		__setConfigValue('bifrost', 'contextSizeOverrides', { custom: 16000 });
		const models: BifrostModel[] = [{ id: 'custom/model' }];
		vi.mocked(fetchModels).mockResolvedValueOnce(models);
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);

		const [info] = await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(info.maxInputTokens).toBe(16000);
	});

	it('falls back to the hardcoded default when nothing resolves the context size', async () => {
		const models: BifrostModel[] = [{ id: 'custom/model' }];
		vi.mocked(fetchModels).mockResolvedValueOnce(models);
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);

		const [info] = await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(info.maxInputTokens).toBe(4096);
		expect(info.tooltip).toContain('context size unknown');
	});

	it('caches results and does not re-fetch within the TTL', async () => {
		vi.mocked(fetchModels).mockResolvedValue([{ id: 'a', max_input_tokens: 1000 }]);
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);

		await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());
		await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(fetchModels).toHaveBeenCalledTimes(1);
	});

	it('re-fetches after invalidateCache()', async () => {
		vi.mocked(fetchModels).mockResolvedValue([{ id: 'a', max_input_tokens: 1000 }]);
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);

		await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());
		provider.invalidateCache();
		await provider.provideLanguageModelChatInformation({ silent: false } as never, fakeToken());

		expect(fetchModels).toHaveBeenCalledTimes(2);
	});

	it('shows a specific error for an auth failure and offers to reconfigure', async () => {
		const { BifrostApiError } = await import('../../src/bifrostClient');
		vi.mocked(fetchModels).mockRejectedValueOnce(new BifrostApiError(401, 'nope'));
		vi.mocked(vscode.window.showErrorMessage).mockResolvedValueOnce('Reconfigure');
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);

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
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);

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
		const provider = new BifrostChatModelProvider(fakeContext(), noProfile);
		const progress = { report: vi.fn() };

		await expect(
			provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken())
		).rejects.toThrow('Bifrost is not configured');
	});

	it('reports streamed text content', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([{ choices: [{ delta: { content: 'Hel' } }] }, { choices: [{ delta: { content: 'lo' } }] }])
		);
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		const reported = progress.report.mock.calls.map((c) => c[0]);
		expect(reported).toHaveLength(2);
		expect(reported[0]).toBeInstanceOf(vscode.LanguageModelTextPart);
		expect((reported[0] as vscode.LanguageModelTextPart).value).toBe('Hel');
		expect((reported[1] as vscode.LanguageModelTextPart).value).toBe('lo');
	});

	it('reports reasoning_content deltas as thinking parts', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([
				{ choices: [{ delta: { reasoning_content: 'let me ' } }] },
				{ choices: [{ delta: { reasoning_content: 'think' } }] },
				{ choices: [{ delta: { content: 'answer' } }] }
			])
		);
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		const reported = progress.report.mock.calls.map((c) => c[0]);
		expect(reported).toHaveLength(3);
		expect(reported[0]).toBeInstanceOf(vscode.LanguageModelThinkingPart!);
		expect((reported[0] as unknown as { value: string }).value).toBe('let me ');
		expect((reported[1] as unknown as { value: string }).value).toBe('think');
		expect(reported[2]).toBeInstanceOf(vscode.LanguageModelTextPart);
	});

	it('reports the OpenRouter-dialect "reasoning" field as thinking parts too', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([{ choices: [{ delta: { reasoning: 'thinking' } }] }])
		);
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		expect(progress.report).toHaveBeenCalledTimes(1);
		expect((progress.report.mock.calls[0][0] as unknown as { value: string }).value).toBe('thinking');
	});

	it('prefers reasoning_content over reasoning when a chunk has both', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([{ choices: [{ delta: { reasoning_content: 'native', reasoning: 'openrouter-style' } }] }])
		);
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		expect((progress.report.mock.calls[0][0] as unknown as { value: string }).value).toBe('native');
	});

	it('still streams content when the host has no thinking part API', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(
			streamOf([{ choices: [{ delta: { reasoning_content: 'dropped' } }] }, { choices: [{ delta: { content: 'answer' } }] }])
		);
		__setThinkingPartAvailable(false);
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		const reported = progress.report.mock.calls.map((c) => c[0]);
		expect(reported).toHaveLength(1);
		expect(reported[0]).toBeInstanceOf(vscode.LanguageModelTextPart);
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
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);
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
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		const part = progress.report.mock.calls[0][0] as vscode.LanguageModelToolCallPart;
		expect(part.input).toEqual({});
	});

	it('passes the session id and active profile to the client', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(streamOf([]));
		const provider = new BifrostChatModelProvider(configureConnection(), { getActiveProfile: () => 'project-a' });

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, { report: vi.fn() } as never, fakeToken());

		const [, , requestContext] = vi.mocked(streamChatCompletion).mock.calls[0];
		expect(requestContext).toEqual({ sessionId: expect.any(String), profile: 'project-a' });
	});

	it('sends the host conversation id as the session id when the host provides one', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(streamOf([]));
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);
		const harnessOptions = { ...options, modelOptions: { max_tokens: 1000, _conversationId: 'conv-42' } };

		await provider.provideLanguageModelChatResponse(modelInfo, [], harnessOptions, { report: vi.fn() } as never, fakeToken());

		expect(vi.mocked(streamChatCompletion).mock.calls[0][2].sessionId).toBe('conv-42');
	});

	it('reads the active profile per request, so a newly selected profile applies immediately', async () => {
		vi.mocked(streamChatCompletion).mockReturnValue(streamOf([]));
		let active: string | undefined = 'first';
		const provider = new BifrostChatModelProvider(configureConnection(), { getActiveProfile: () => active });

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, { report: vi.fn() } as never, fakeToken());
		active = undefined;
		vi.mocked(streamChatCompletion).mockReturnValue(streamOf([]));
		await provider.provideLanguageModelChatResponse(modelInfo, [], options, { report: vi.fn() } as never, fakeToken());

		expect(vi.mocked(streamChatCompletion).mock.calls[0][2].profile).toBe('first');
		expect(vi.mocked(streamChatCompletion).mock.calls[1][2].profile).toBeUndefined();
	});

	it('ignores chunks with no choices', async () => {
		vi.mocked(streamChatCompletion).mockReturnValueOnce(streamOf([{ choices: [] }, { choices: undefined }]));
		const provider = new BifrostChatModelProvider(configureConnection(), noProfile);
		const progress = { report: vi.fn() };

		await provider.provideLanguageModelChatResponse(modelInfo, [], options, progress as never, fakeToken());

		expect(progress.report).not.toHaveBeenCalled();
	});
});

describe('BifrostChatModelProvider.provideTokenCount', () => {
	it('estimates token count from a plain string', async () => {
		const provider = new BifrostChatModelProvider(fakeContext(), noProfile);

		const count = await provider.provideTokenCount(
			{} as never,
			'12345678',
			fakeToken()
		);

		expect(count).toBe(2);
	});

	it('rounds up partial estimates', async () => {
		const provider = new BifrostChatModelProvider(fakeContext(), noProfile);

		const count = await provider.provideTokenCount({} as never, '123', fakeToken());

		expect(count).toBe(1);
	});

	it('estimates token count from a chat message by extracting its plain text', async () => {
		const provider = new BifrostChatModelProvider(fakeContext(), noProfile);
		const message = {
			role: vscode.LanguageModelChatMessageRole.User,
			content: [new vscode.LanguageModelTextPart('12345678')]
		} as unknown as import('vscode').LanguageModelChatRequestMessage;

		const count = await provider.provideTokenCount({} as never, message, fakeToken());

		expect(count).toBe(2);
	});
});
