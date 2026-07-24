import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { __resetMockVscodeState, __setConfigValue } from '../mocks/vscode';
import { getConnection, promptForConnection, registerManageCommand } from '../../src/config';

function fakeContext(secrets: Record<string, string> = {}) {
	const store = new Map(Object.entries(secrets));
	return {
		secrets: {
			get: vi.fn(async (key: string) => store.get(key)),
			store: vi.fn(async (key: string, value: string) => {
				store.set(key, value);
			})
		}
	} as unknown as import('vscode').ExtensionContext;
}

describe('getConnection', () => {
	beforeEach(() => __resetMockVscodeState());
	afterEach(() => __resetMockVscodeState());

	it('returns undefined when no base URL is configured', async () => {
		const context = fakeContext({ 'bifrost.apiKey': 'key' });

		expect(await getConnection(context)).toBeUndefined();
	});

	it('returns undefined when no API key is stored', async () => {
		__setConfigValue('bifrost', 'baseUrl', 'https://bifrost.example.com');
		const context = fakeContext();

		expect(await getConnection(context)).toBeUndefined();
	});

	it('returns the connection when both baseUrl and apiKey are present', async () => {
		__setConfigValue('bifrost', 'baseUrl', 'https://bifrost.example.com');
		const context = fakeContext({ 'bifrost.apiKey': 'secret-key' });

		expect(await getConnection(context)).toEqual({ baseUrl: 'https://bifrost.example.com', apiKey: 'secret-key' });
	});

	it('trims whitespace and trailing slashes from the base URL', async () => {
		__setConfigValue('bifrost', 'baseUrl', '  https://bifrost.example.com//  ');
		const context = fakeContext({ 'bifrost.apiKey': 'secret-key' });

		expect(await getConnection(context)).toEqual({ baseUrl: 'https://bifrost.example.com', apiKey: 'secret-key' });
	});

	it('treats a blank base URL as not configured', async () => {
		__setConfigValue('bifrost', 'baseUrl', '   ');
		const context = fakeContext({ 'bifrost.apiKey': 'secret-key' });

		expect(await getConnection(context)).toBeUndefined();
	});
});

describe('promptForConnection', () => {
	beforeEach(() => __resetMockVscodeState());
	afterEach(() => __resetMockVscodeState());

	it('returns undefined when the base URL prompt is dismissed', async () => {
		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);
		const context = fakeContext();

		expect(await promptForConnection(context)).toBeUndefined();
		expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1);
	});

	it('returns undefined when the api key prompt is dismissed', async () => {
		vi.mocked(vscode.window.showInputBox)
			.mockResolvedValueOnce('https://bifrost.example.com')
			.mockResolvedValueOnce(undefined);
		const context = fakeContext();

		expect(await promptForConnection(context)).toBeUndefined();
	});

	it('saves the base URL and secret, and returns the trimmed connection', async () => {
		vi.mocked(vscode.window.showInputBox)
			.mockResolvedValueOnce('https://bifrost.example.com/ ')
			.mockResolvedValueOnce(' secret-key ');
		const context = fakeContext();

		const result = await promptForConnection(context);

		expect(result).toEqual({ baseUrl: 'https://bifrost.example.com', apiKey: 'secret-key' });
		expect(context.secrets.store).toHaveBeenCalledWith('bifrost.apiKey', 'secret-key');
	});

	it('rejects an invalid base URL via validateInput', async () => {
		vi.mocked(vscode.window.showInputBox).mockImplementationOnce(async (options) => {
			expect(options?.validateInput?.('not a url')).toBe('Enter a valid URL, e.g. https://bifrost.example.com');
			expect(options?.validateInput?.('')).toBe('A base URL is required.');
			expect(options?.validateInput?.('https://ok.example.com')).toBeUndefined();
			return undefined;
		});
		const context = fakeContext();

		await promptForConnection(context);
	});

	it('rejects a blank api key via validateInput', async () => {
		vi.mocked(vscode.window.showInputBox)
			.mockResolvedValueOnce('https://bifrost.example.com')
			.mockImplementationOnce(async (options) => {
				expect(options?.validateInput?.('   ')).toBe('A virtual key is required.');
				expect(options?.validateInput?.('key')).toBeUndefined();
				return undefined;
			});
		const context = fakeContext();

		await promptForConnection(context);
	});
});

describe('registerManageCommand', () => {
	beforeEach(() => __resetMockVscodeState());
	afterEach(() => __resetMockVscodeState());

	it('registers the bifrost.manage command', () => {
		const context = fakeContext();

		registerManageCommand(context, vi.fn());

		expect(vscode.commands.registerCommand).toHaveBeenCalledWith('bifrost.manage', expect.any(Function));
	});

	it('calls onUpdated and shows a confirmation after a successful save', async () => {
		vi.mocked(vscode.window.showInputBox)
			.mockResolvedValueOnce('https://bifrost.example.com')
			.mockResolvedValueOnce('secret-key');
		const onUpdated = vi.fn();
		const context = fakeContext();
		registerManageCommand(context, onUpdated);
		const handler = vi.mocked(vscode.commands.registerCommand).mock.calls[0][1] as () => Promise<void>;

		await handler();

		expect(onUpdated).toHaveBeenCalledTimes(1);
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Bifrost connection saved.');
	});

	it('does not call onUpdated if the prompt was cancelled', async () => {
		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);
		const onUpdated = vi.fn();
		const context = fakeContext();
		registerManageCommand(context, onUpdated);
		const handler = vi.mocked(vscode.commands.registerCommand).mock.calls[0][1] as () => Promise<void>;

		await handler();

		expect(onUpdated).not.toHaveBeenCalled();
	});
});
