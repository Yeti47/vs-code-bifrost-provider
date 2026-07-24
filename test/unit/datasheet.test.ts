import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { __resetMockVscodeState } from '../mocks/vscode';
import { BifrostDatasheet } from '../../src/datasheet';

function fakeContext() {
	return {
		globalStorageUri: vscode.Uri.file('/fake/global-storage')
	} as unknown as import('vscode').ExtensionContext;
}

function fakeToken(): import('vscode').CancellationToken {
	return new vscode.CancellationTokenSource().token;
}

function jsonResponse(body: unknown, ok = true): Response {
	return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

async function writeDiskCache(context: import('vscode').ExtensionContext, fetchedAt: number, entries: Record<string, number>) {
	const uri = vscode.Uri.joinPath((context as unknown as { globalStorageUri: vscode.Uri }).globalStorageUri, 'datasheet-index.json');
	await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify({ fetchedAt, entries })));
}

describe('BifrostDatasheet', () => {
	beforeEach(() => {
		__resetMockVscodeState();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('resolves a model id to its max_input_tokens from the registry', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonResponse({ 'openrouter/kimi-k3': { mode: 'chat', max_input_tokens: 32000 } }))
		);
		const datasheet = new BifrostDatasheet(fakeContext());

		const result = await datasheet.lookup('opencode-go/kimi-k3', fakeToken());

		expect(result).toBe(32000);
	});

	it('ignores entries that are not chat models', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonResponse({ 'provider/embed-model': { mode: 'embedding', max_input_tokens: 8000 } })
			)
		);
		const datasheet = new BifrostDatasheet(fakeContext());

		expect(await datasheet.lookup('embed-model', fakeToken())).toBeUndefined();
	});

	it('ignores entries with no max_input_tokens', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ 'provider/model-x': { mode: 'chat' } })));
		const datasheet = new BifrostDatasheet(fakeContext());

		expect(await datasheet.lookup('model-x', fakeToken())).toBeUndefined();
	});

	it('keeps the highest max_input_tokens across duplicate slugs', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonResponse({
					'providerA/model-x': { mode: 'chat', max_input_tokens: 4096 },
					'providerB/model-x': { mode: 'chat', max_input_tokens: 8192 }
				})
			)
		);
		const datasheet = new BifrostDatasheet(fakeContext());

		expect(await datasheet.lookup('providerC/model-x', fakeToken())).toBe(8192);
	});

	it('returns undefined when the fetch fails and there is no cache', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('network down');
			})
		);
		const datasheet = new BifrostDatasheet(fakeContext());

		expect(await datasheet.lookup('anything', fakeToken())).toBeUndefined();
	});

	it('serves subsequent lookups from memory without re-fetching', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ 'provider/model-x': { mode: 'chat', max_input_tokens: 1234 } }));
		vi.stubGlobal('fetch', fetchMock);
		const datasheet = new BifrostDatasheet(fakeContext());

		await datasheet.lookup('model-x', fakeToken());
		await datasheet.lookup('model-x', fakeToken());

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('falls back to a stale on-disk cache when the network fetch fails', async () => {
		const context = fakeContext();
		await writeDiskCache(context, Date.now() - 25 * 60 * 60 * 1000, { 'model-x': 5555 });
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('network down');
			})
		);
		const datasheet = new BifrostDatasheet(context);

		expect(await datasheet.lookup('model-x', fakeToken())).toBe(5555);
	});

	it('fires onDidUpdate after a successful background refresh', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonResponse({ 'provider/model-x': { mode: 'chat', max_input_tokens: 999 } }))
		);
		const datasheet = new BifrostDatasheet(fakeContext());
		const onUpdate = vi.fn();
		datasheet.onDidUpdate(onUpdate);

		await datasheet.lookup('model-x', fakeToken());

		expect(onUpdate).toHaveBeenCalledTimes(1);
	});

	it('dedupes concurrent lookups into a single in-flight fetch', async () => {
		let resolveFetch!: (res: Response) => void;
		const pending = new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		});
		const fetchMock = vi.fn(() => pending);
		vi.stubGlobal('fetch', fetchMock);
		const datasheet = new BifrostDatasheet(fakeContext());

		const [first, second] = [datasheet.lookup('model-x', fakeToken()), datasheet.lookup('model-x', fakeToken())];
		resolveFetch(jsonResponse({ 'provider/model-x': { mode: 'chat', max_input_tokens: 42 } }));

		expect(await first).toBe(42);
		expect(await second).toBe(42);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
