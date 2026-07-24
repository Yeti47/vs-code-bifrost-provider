import * as vscode from 'vscode';

export function tokenToSignal(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	}
	token.onCancellationRequested(() => controller.abort());
	return controller.signal;
}
