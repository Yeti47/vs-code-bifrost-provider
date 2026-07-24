import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BifrostApiError, fetchModels, streamChatCompletion } from '../../src/bifrostClient';
import { BifrostConnection, BifrostModel } from '../../src/types';

const connection: BifrostConnection = { baseUrl: 'https://bifrost.example.com', apiKey: 'test-key' };

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
	return {
		ok: init?.ok ?? true,
		status: init?.status ?? 200,
		statusText: 'OK',
		json: async () => body,
		text: async () => JSON.stringify(body)
	} as unknown as Response;
}

describe('fetchModels', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns models from a single page', async () => {
		const models: BifrostModel[] = [{ id: 'a' }, { id: 'b' }];
		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: models }));

		const result = await fetchModels(connection, new AbortController().signal);

		expect(result).toEqual(models);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('sends the api key as a bearer token', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: [] }));

		await fetchModels(connection, new AbortController().signal);

		const [, options] = vi.mocked(fetch).mock.calls[0];
		expect((options as RequestInit).headers).toEqual({ Authorization: 'Bearer test-key' });
	});

	it('follows pagination via next_page_token until it is absent', async () => {
		vi.mocked(fetch)
			.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'a' }], next_page_token: 'page2' }))
			.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'b' }] }));

		const result = await fetchModels(connection, new AbortController().signal);

		expect(result).toEqual([{ id: 'a' }, { id: 'b' }]);
		expect(fetch).toHaveBeenCalledTimes(2);
		const secondUrl = new URL(vi.mocked(fetch).mock.calls[1][0] as string);
		expect(secondUrl.searchParams.get('page_token')).toBe('page2');
	});

	it('treats a missing data array as no models', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}));

		const result = await fetchModels(connection, new AbortController().signal);

		expect(result).toEqual([]);
	});

	it('throws a BifrostApiError with status and body text on a non-ok response', async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: false,
			status: 401,
			statusText: 'Unauthorized',
			text: async () => 'invalid virtual key'
		} as unknown as Response);

		await expect(fetchModels(connection, new AbortController().signal)).rejects.toMatchObject({
			status: 401,
			message: 'invalid virtual key'
		});
	});

	it('wraps errors in BifrostApiError instances', async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: false,
			status: 500,
			statusText: 'Server Error',
			text: async () => {
				throw new Error('body read failed');
			}
		} as unknown as Response);

		await expect(fetchModels(connection, new AbortController().signal)).rejects.toBeInstanceOf(BifrostApiError);
	});

	it('falls back to statusText when reading the error body fails', async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: false,
			status: 500,
			statusText: 'Server Error',
			text: async () => {
				throw new Error('body read failed');
			}
		} as unknown as Response);

		await expect(fetchModels(connection, new AbortController().signal)).rejects.toMatchObject({
			message: 'Server Error'
		});
	});
});

function sseResponse(chunks: string[], overrides?: { ok?: boolean; status?: number; noBody?: boolean }): Response {
	let index = 0;
	const encoder = new TextEncoder();
	const body = overrides?.noBody
		? null
		: {
			getReader: () => ({
				read: async () => {
					if (index >= chunks.length) {
						return { value: undefined, done: true };
					}
					const value = encoder.encode(chunks[index]);
					index += 1;
					return { value, done: false };
				},
				releaseLock: () => { }
			})
		};

	return {
		ok: overrides?.ok ?? true,
		status: overrides?.status ?? 200,
		statusText: 'OK',
		body,
		text: async () => 'error body'
	} as unknown as Response;
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of gen) {
		items.push(item);
	}
	return items;
}

describe('streamChatCompletion', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const request = { model: 'm', messages: [], stream: true as const };

	it('yields parsed chunks from data: lines', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			sseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n', 'data: [DONE]\n'])
		);

		const results = await collect(streamChatCompletion(connection, request, new AbortController().signal));

		expect(results).toEqual([{ choices: [{ delta: { content: 'hi' } }] }]);
	});

	it('stops iterating once it sees a [DONE] sentinel', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			sseResponse(['data: {"choices":[]}\n', 'data: [DONE]\n', 'data: {"choices":[{"delta":{"content":"unreachable"}}]}\n'])
		);

		const results = await collect(streamChatCompletion(connection, request, new AbortController().signal));

		expect(results).toEqual([{ choices: [] }]);
	});

	it('ignores non-data lines (e.g. SSE comments/event lines)', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			sseResponse([': keep-alive\n', 'event: message\n', 'data: {"choices":[]}\n', 'data: [DONE]\n'])
		);

		const results = await collect(streamChatCompletion(connection, request, new AbortController().signal));

		expect(results).toEqual([{ choices: [] }]);
	});

	it('ignores malformed JSON in a data line instead of throwing', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			sseResponse(['data: {not valid json\n', 'data: {"choices":[]}\n', 'data: [DONE]\n'])
		);

		const results = await collect(streamChatCompletion(connection, request, new AbortController().signal));

		expect(results).toEqual([{ choices: [] }]);
	});

	it('reassembles a data line split across multiple stream reads', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			sseResponse(['data: {"choices":[{"del', 'ta":{"content":"hi"}}]}\n', 'data: [DONE]\n'])
		);

		const results = await collect(streamChatCompletion(connection, request, new AbortController().signal));

		expect(results).toEqual([{ choices: [{ delta: { content: 'hi' } }] }]);
	});

	it('stops without a trailing [DONE] once the stream simply ends', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(sseResponse(['data: {"choices":[]}\n']));

		const results = await collect(streamChatCompletion(connection, request, new AbortController().signal));

		expect(results).toEqual([{ choices: [] }]);
	});

	it('throws a BifrostApiError on a non-ok response', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(sseResponse([], { ok: false, status: 500 }));

		await expect(collect(streamChatCompletion(connection, request, new AbortController().signal))).rejects.toBeInstanceOf(
			BifrostApiError
		);
	});

	it('throws a BifrostApiError when the response has no body', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(sseResponse([], { noBody: true }));

		await expect(collect(streamChatCompletion(connection, request, new AbortController().signal))).rejects.toBeInstanceOf(
			BifrostApiError
		);
	});
});
