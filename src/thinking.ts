import * as vscode from 'vscode';

/**
 * Bridge to `vscode.LanguageModelThinkingPart`, the API VS Code provides for carrying a model's
 * reasoning through the chat response stream and back into history on the next turn.
 *
 * That class is still behind the `languageModelThinkingPart` API proposal, so it is absent from the
 * stable `@types/vscode` typings. It is, however, exposed unconditionally on the extension API
 * namespace at runtime — the proposal gates the typings, not access to the class. We therefore reach
 * for it dynamically instead of declaring `enabledApiProposals`, which would block Marketplace
 * publishing and require launching VS Code with `--enable-proposed-api`.
 *
 * Everything here degrades gracefully: on a host that does not expose the class we simply drop
 * reasoning from the response stream, which is the behaviour we had before.
 */

export interface ThinkingPartLike {
	value: string | string[];
	id?: string;
	metadata?: { readonly [key: string]: unknown };
}

type ThinkingPartCtor = new (
	value: string | string[],
	id?: string,
	metadata?: { readonly [key: string]: unknown }
) => ThinkingPartLike;

function thinkingPartCtor(): ThinkingPartCtor | undefined {
	return (vscode as unknown as { LanguageModelThinkingPart?: ThinkingPartCtor }).LanguageModelThinkingPart;
}

/** Whether this host exposes the thinking part API at all. Reported in diagnostics. */
export function isThinkingPartApiAvailable(): boolean {
	return thinkingPartCtor() !== undefined;
}

/**
 * Builds a thinking part for the response stream, or `undefined` if this host has no such API.
 *
 * The part must be a genuine `LanguageModelThinkingPart` instance: VS Code matches response parts by
 * `instanceof` and logs anything unrecognised as an "UNKNOWN part" before discarding it, so a
 * hand-rolled stand-in would be silently dropped.
 */
export function createThinkingPart(value: string, id?: string): vscode.LanguageModelResponsePart | undefined {
	const Ctor = thinkingPartCtor();
	if (!Ctor) {
		return undefined;
	}
	return new Ctor(value, id) as unknown as vscode.LanguageModelResponsePart;
}

/**
 * Detects thinking parts replayed to us in request history.
 *
 * `LanguageModelChatRequestMessage.content` is typed `ReadonlyArray<LanguageModelInputPart | unknown>`
 * precisely so hosts can pass part types the stable typings do not name yet.
 */
export function isThinkingPart(part: unknown): part is ThinkingPartLike {
	if (typeof part !== 'object' || part === null) {
		return false;
	}
	const Ctor = thinkingPartCtor();
	if (Ctor && part instanceof Ctor) {
		return true;
	}
	// Fall back to the constructor name so a host that hands us thinking parts without exposing the
	// class is still understood. Deliberately not duck-typed on `value`, which text parts also carry.
	return part.constructor?.name === 'LanguageModelThinkingPart';
}

/** Flattens a thinking part's value, which may arrive as a single string or a list of fragments. */
export function thinkingPartText(part: ThinkingPartLike): string {
	if (Array.isArray(part.value)) {
		return part.value.join('');
	}
	return typeof part.value === 'string' ? part.value : '';
}
