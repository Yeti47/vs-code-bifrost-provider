import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

// Bounds memory for long-running windows; oldest conversation is evicted first.
const MAX_TRACKED_CONVERSATIONS = 50;

interface TrackedConversation {
	sessionId: string;
	transcript: string[];
}

const conversations: TrackedConversation[] = [];

/**
 * Derives a stable id for the conversation `messages` belongs to: the same id is
 * returned across turns of one conversation, and a fresh one is minted otherwise.
 *
 * VS Code's LM API resends the full transcript on every turn but exposes no
 * conversation id, so conversations are recognized structurally instead: a request
 * whose messages extend a previously seen transcript is treated as the same one
 * (e.g. an edited/regenerated earlier turn just starts a new tracked conversation,
 * which only costs cache warmth, not correctness).
 */
export function resolveConversationSessionId(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
	const transcript = messages.map(fingerprintMessage);

	for (const conversation of conversations) {
		if (isPrefix(conversation.transcript, transcript)) {
			conversation.transcript = transcript;
			return conversation.sessionId;
		}
	}

	const sessionId = randomUUID();
	conversations.push({ sessionId, transcript });
	if (conversations.length > MAX_TRACKED_CONVERSATIONS) {
		conversations.shift();
	}
	return sessionId;
}

function isPrefix(prev: readonly string[], curr: readonly string[]): boolean {
	if (prev.length === 0 || prev.length > curr.length) {
		return false;
	}
	for (let i = 0; i < prev.length; i++) {
		if (prev[i] !== curr[i]) {
			return false;
		}
	}
	return true;
}

function fingerprintMessage(message: vscode.LanguageModelChatRequestMessage): string {
	const parts = message.content.map((part) => {
		if (part instanceof vscode.LanguageModelTextPart) {
			return `text:${part.value}`;
		}
		if (part instanceof vscode.LanguageModelToolCallPart) {
			return `call:${part.callId}:${part.name}:${JSON.stringify(part.input)}`;
		}
		if (part instanceof vscode.LanguageModelToolResultPart) {
			return `result:${part.callId}`;
		}
		if (part instanceof vscode.LanguageModelDataPart) {
			return `data:${part.mimeType}:${part.data.length}`;
		}
		return 'unknown';
	});
	return `${message.role}:${parts.join('|')}`;
}
