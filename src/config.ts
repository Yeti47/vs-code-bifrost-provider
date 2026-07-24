import * as vscode from 'vscode';
import { BifrostConnection } from './types';

const CONFIG_SECTION = 'bifrost';
const SECRET_KEY = 'bifrost.apiKey';

function getBaseUrl(): string | undefined {
	const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('baseUrl');
	const trimmed = raw?.trim().replace(/\/+$/, '');
	return trimmed ? trimmed : undefined;
}

async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
	return context.secrets.get(SECRET_KEY);
}

export async function getConnection(context: vscode.ExtensionContext): Promise<BifrostConnection | undefined> {
	const baseUrl = getBaseUrl();
	const apiKey = await getApiKey(context);
	if (!baseUrl || !apiKey) {
		return undefined;
	}
	return { baseUrl, apiKey };
}

function validateUrl(value: string): string | undefined {
	if (!value.trim()) {
		return 'A base URL is required.';
	}
	try {
		new URL(value.trim());
		return undefined;
	} catch {
		return 'Enter a valid URL, e.g. https://bifrost.example.com';
	}
}

export async function promptForConnection(context: vscode.ExtensionContext): Promise<BifrostConnection | undefined> {
	const baseUrlInput = await vscode.window.showInputBox({
		title: 'Bifrost Connection (1/2)',
		prompt: 'Base URL of your Bifrost gateway',
		placeHolder: 'https://bifrost.example.com',
		value: getBaseUrl(),
		ignoreFocusOut: true,
		validateInput: validateUrl
	});
	if (baseUrlInput === undefined) {
		return undefined;
	}

	const apiKeyInput = await vscode.window.showInputBox({
		title: 'Bifrost Connection (2/2)',
		prompt: 'Virtual key for your Bifrost gateway',
		password: true,
		ignoreFocusOut: true,
		validateInput: (value) => (value.trim() ? undefined : 'A virtual key is required.')
	});
	if (apiKeyInput === undefined) {
		return undefined;
	}

	const baseUrl = baseUrlInput.trim().replace(/\/+$/, '');
	const apiKey = apiKeyInput.trim();

	await vscode.workspace.getConfiguration(CONFIG_SECTION).update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
	await context.secrets.store(SECRET_KEY, apiKey);

	return { baseUrl, apiKey };
}

export function registerManageCommand(context: vscode.ExtensionContext, onUpdated: () => void): vscode.Disposable {
	return vscode.commands.registerCommand('bifrost.manage', async () => {
		const connection = await promptForConnection(context);
		if (connection) {
			vscode.window.showInformationMessage('Bifrost connection saved.');
			onUpdated();
		}
	});
}
