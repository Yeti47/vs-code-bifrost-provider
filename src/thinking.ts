import * as vscode from 'vscode';

/**
 * Bridge to `vscode.LanguageModelThinkingPart`, VS Code's carrier for showing a model's reasoning
 * in the chat response stream.
 *
 * That class is still behind the `languageModelThinkingPart` API proposal, so it is absent from the
 * stable `@types/vscode` typings. It is, however, exposed unconditionally on the extension API
 * namespace at runtime — the proposal gates the typings, not access to the class — so this resolves
 * it dynamically instead of declaring `enabledApiProposals`, which would block Marketplace
 * publishing and require launching VS Code with `--enable-proposed-api`.
 *
 * Display-only: this only ever builds thinking parts to report to the response stream. Nothing here
 * reads them back out of replayed history — round-tripping reasoning to satisfy a provider's replay
 * requirement is out of scope for this extension.
 */

type ThinkingPartCtor = new (value: string) => vscode.LanguageModelResponsePart;

/** Builds a thinking part for the response stream, or `undefined` if this host has no such API. */
export function createThinkingPart(value: string): vscode.LanguageModelResponsePart | undefined {
	const Ctor = (vscode as unknown as { LanguageModelThinkingPart?: ThinkingPartCtor }).LanguageModelThinkingPart;
	return Ctor ? new Ctor(value) : undefined;
}
