import * as vscode from 'vscode';
import { registerManageCommand } from './config';
import { registerProfileUi } from './profileUi';
import { ProfileStore } from './profiles';
import { BifrostChatModelProvider } from './provider';

export function activate(context: vscode.ExtensionContext): void {
	const profiles = new ProfileStore();
	const provider = new BifrostChatModelProvider(context, profiles);

	context.subscriptions.push(
		profiles,
		provider,
		vscode.lm.registerLanguageModelChatProvider('bifrost', provider),
		registerManageCommand(context, () => provider.invalidateCache()),
		registerProfileUi(profiles),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('bifrost.contextSizeOverrides')) {
				provider.invalidateCache();
			}
		})
	);
}

export function deactivate(): void { }
