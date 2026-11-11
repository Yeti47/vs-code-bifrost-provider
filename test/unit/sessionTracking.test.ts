import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { resolveConversationSessionId, resolveSessionId } from '../../src/sessionTracking';

function userMessage(text: string) {
	return {
		role: vscode.LanguageModelChatMessageRole.User,
		content: [new vscode.LanguageModelTextPart(text)]
	} as unknown as import('vscode').LanguageModelChatRequestMessage;
}

function assistantMessage(text: string) {
	return {
		role: vscode.LanguageModelChatMessageRole.Assistant,
		content: [new vscode.LanguageModelTextPart(text)]
	} as unknown as import('vscode').LanguageModelChatRequestMessage;
}

describe('resolveConversationSessionId', () => {
	it('returns the same id across turns of the same conversation', () => {
		const turn1 = [userMessage('hello')];
		const turn2 = [...turn1, assistantMessage('hi there'), userMessage('follow up')];

		const id1 = resolveConversationSessionId(turn1);
		const id2 = resolveConversationSessionId(turn2);

		expect(id2).toBe(id1);
	});

	it('returns different ids for unrelated conversations', () => {
		const id1 = resolveConversationSessionId([userMessage('conversation A')]);
		const id2 = resolveConversationSessionId([userMessage('conversation B')]);

		expect(id2).not.toBe(id1);
	});

	it('starts a new id when an earlier turn is edited rather than extended', () => {
		const original = [userMessage('original opening')];
		const edited = [userMessage('edited opening')];

		const id1 = resolveConversationSessionId(original);
		const id2 = resolveConversationSessionId(edited);

		expect(id2).not.toBe(id1);
	});

	it('keeps tracking the same conversation across three or more turns', () => {
		const turn1 = [userMessage('first')];
		const turn2 = [...turn1, assistantMessage('reply'), userMessage('second')];
		const turn3 = [...turn2, assistantMessage('reply 2'), userMessage('third')];

		const id1 = resolveConversationSessionId(turn1);
		resolveConversationSessionId(turn2);
		const id3 = resolveConversationSessionId(turn3);

		expect(id3).toBe(id1);
	});
});

describe('resolveSessionId', () => {
	it('uses the host conversation id when one is provided', () => {
		const id = resolveSessionId([userMessage('hello')], { _conversationId: '666846a6-9402-4ab2-b29c-2792c11b9f21' });

		expect(id).toBe('666846a6-9402-4ab2-b29c-2792c11b9f21');
	});

	it('keeps the host id across turns even when the transcript is not a strict extension', () => {
		const options = { _conversationId: 'conv-1' };
		// The Copilot harness may rewrite earlier messages (e.g. trimmed context) between turns.
		const id1 = resolveSessionId([userMessage('first version of turn 1')], options);
		const id2 = resolveSessionId([userMessage('rewritten turn 1'), userMessage('turn 2')], options);

		expect(id1).toBe('conv-1');
		expect(id2).toBe('conv-1');
	});

	it('falls back to structural tracking when no host id is provided', () => {
		const turn1 = [userMessage('no host id, turn 1')];
		const turn2 = [...turn1, assistantMessage('reply'), userMessage('turn 2')];

		const id1 = resolveSessionId(turn1, { _capturingTokenCorrelationId: 'per-request-value' });
		const id2 = resolveSessionId(turn2, undefined);

		expect(id2).toBe(id1);
		expect(id1).not.toBe('per-request-value');
	});

	it.each([
		['an empty string', ''],
		['a non-string', 42],
		['a value with a newline', 'conv\ninjected: header'],
		['a value with spaces', 'conv id'],
		['an overly long value', 'x'.repeat(201)]
	])('ignores %s as host id and falls back', (_label, value) => {
		const id = resolveSessionId([userMessage(`invalid host id: ${String(value).slice(0, 20)}`)], { _conversationId: value });

		expect(id).not.toBe(value);
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
	});
});
