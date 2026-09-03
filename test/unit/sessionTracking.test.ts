import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { resolveConversationSessionId } from '../../src/sessionTracking';

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
