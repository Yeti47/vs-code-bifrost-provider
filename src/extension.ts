import * as vscode from 'vscode';
import { registerManageCommand } from './config';
import { BifrostChatModelProvider } from './provider';

export function activate(context: vscode.ExtensionContext): void {
	const provider = new BifrostChatModelProvider(context);

	context.subscriptions.push(
		provider,
		vscode.lm.registerLanguageModelChatProvider('bifrost', provider),
		registerManageCommand(context, () => provider.invalidateCache()),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('bifrost.contextSizeOverrides')) {
				provider.invalidateCache();
			}
		})
	);
}

export function deactivate(): void { }
