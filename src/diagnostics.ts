import * as vscode from 'vscode';

/**
 * One-line request/response summaries written to the "Bifrost" output channel.
 *
 * This exists to answer, from a real session, questions that cannot be settled by reading code:
 * whether the upstream provider actually streams `reasoning_content`, whether the chat client
 * replays thinking parts back to us in history, and therefore which of the two reasoning round-trip
 * paths is doing the work.
 *
 * Only counts and lengths are recorded — never reasoning text, prompt content, or tool arguments.
 */
export class Diagnostics implements vscode.Disposable {
	private readonly channel: vscode.OutputChannel;

	constructor(name = 'Bifrost') {
		this.channel = vscode.window.createOutputChannel(name);
	}

	log(message: string): void {
		this.channel.appendLine(`[${new Date().toISOString()}] ${message}`);
	}

	dispose(): void {
		this.channel.dispose();
	}
}

export function formatFields(fields: Record<string, string | number | boolean>): string {
	return Object.entries(fields)
		.map(([key, value]) => `${key}=${value}`)
		.join(' ');
}
