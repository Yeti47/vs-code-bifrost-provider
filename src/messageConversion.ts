import * as vscode from 'vscode';
import { applyReasoning } from './reasoning';
import { ModelReasoningCache } from './reasoningCache';
import { isThinkingPart, thinkingPartText } from './thinking';
import { OpenAIContentPart, OpenAIMessage, OpenAITool, OpenAIToolCall } from './types';

/**
 * @param reasoning Optional fallback source of assistant reasoning, used when the chat client did
 * not replay thinking parts in the history. See {@link ModelReasoningCache}.
 */
export function toOpenAIMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	reasoning?: ModelReasoningCache
): OpenAIMessage[] {
	const result: OpenAIMessage[] = [];
	for (const message of messages) {
		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			result.push(convertAssistantMessage(message, reasoning));
		} else {
			result.push(...convertUserMessage(message));
		}
	}
	return result;
}

export function toOpenAITools(tools?: readonly vscode.LanguageModelChatTool[]): OpenAITool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	return tools.map((tool) => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema
		}
	}));
}

export function toolModeToChoice(mode: vscode.LanguageModelChatToolMode): 'auto' | 'required' {
	return mode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
}

function convertAssistantMessage(
	message: vscode.LanguageModelChatRequestMessage,
	reasoning?: ModelReasoningCache
): OpenAIMessage {
	const textParts: string[] = [];
	const thinkingParts: string[] = [];
	const toolCalls: OpenAIToolCall[] = [];

	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			textParts.push(part.value);
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			toolCalls.push({
				id: part.callId,
				type: 'function',
				function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) }
			});
		} else if (isThinkingPart(part)) {
			thinkingParts.push(thinkingPartText(part));
		}
	}

	const openAiMessage: OpenAIMessage = {
		role: 'assistant',
		content: textParts.length > 0 ? textParts.join('') : null
	};
	if (toolCalls.length > 0) {
		openAiMessage.tool_calls = toolCalls;
	}

	// Our own record is preferred over what the client replayed: it preserves the upstream's dialect
	// and its verbatim `reasoning_details`, where a thinking part only carries flattened text. The
	// replayed text is the fallback for turns the cache has already evicted.
	const cached = reasoning?.lookup(toolCalls.map((call) => call.id));
	const replayed = thinkingParts.join('');
	// Only fall back to replayed text for a model we have actually seen produce reasoning. History
	// keeps thinking parts from whichever model wrote them, so after a mid-conversation model switch
	// they are still present — replaying them blindly would send a reasoning field to a model that
	// has never emitted one, which is what the per-model keying exists to prevent.
	const dialect = reasoning?.dialect();
	if (cached) {
		applyReasoning(openAiMessage, cached);
	} else if (replayed && dialect) {
		applyReasoning(openAiMessage, { text: replayed, textField: dialect });
	}
	return openAiMessage;
}

function convertUserMessage(message: vscode.LanguageModelChatRequestMessage): OpenAIMessage[] {
	const messages: OpenAIMessage[] = [];
	const contentParts: OpenAIContentPart[] = [];

	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelToolResultPart) {
			messages.push({
				role: 'tool',
				tool_call_id: part.callId,
				content: extractToolResultText(part.content)
			});
		} else if (part instanceof vscode.LanguageModelTextPart) {
			contentParts.push({ type: 'text', text: part.value });
		} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
			contentParts.push({
				type: 'image_url',
				image_url: { url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}` }
			});
		}
	}

	if (contentParts.length > 0) {
		const onlyText = contentParts.length === 1 && contentParts[0].type === 'text';
		messages.push({
			role: 'user',
			content: onlyText ? (contentParts[0] as { type: 'text'; text: string }).text : contentParts,
			name: message.name
		});
	}

	return messages;
}

function extractToolResultText(content: readonly unknown[]): string {
	return content
		.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
		.map((part) => part.value)
		.join('\n');
}

export function extractPlainText(message: vscode.LanguageModelChatRequestMessage): string {
	return message.content
		.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ''))
		.join('');
}

/**
 * Diagnostic-only trace of why (or why not) reasoning got attached during conversion, mirroring
 * `convertAssistantMessage`'s decision without duplicating its output. Exists to answer, from a real
 * session, why `sentReasoning` can stay at 0 even once `historyThinkingParts` is well above zero —
 * something neither our synthetic tests nor reading the code has been able to explain.
 */
export interface ReasoningReplayTrace {
	assistantMessages: number;
	/** Assistant messages whose content included at least one LanguageModelToolCallPart. */
	withToolCalls: number;
	/** Assistant messages whose content included at least one recognized thinking part. */
	withThinkingParts: number;
	/** Of `withToolCalls`, how many had a tool call id the cache actually recognized. */
	cacheHits: number;
	dialectKnown: boolean;
	/** First historical tool call id seen, to compare byte-for-byte against an id we assigned. */
	sampleToolCallId?: string;
}

export function traceReasoningReplay(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	reasoning?: ModelReasoningCache
): ReasoningReplayTrace {
	const trace: ReasoningReplayTrace = {
		assistantMessages: 0,
		withToolCalls: 0,
		withThinkingParts: 0,
		cacheHits: 0,
		dialectKnown: reasoning?.dialect() !== undefined
	};

	for (const message of messages) {
		if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) {
			continue;
		}
		trace.assistantMessages++;

		const toolCallIds: string[] = [];
		let hasThinking = false;
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCallIds.push(part.callId);
			} else if (isThinkingPart(part)) {
				hasThinking = true;
			}
		}

		if (toolCallIds.length > 0) {
			trace.withToolCalls++;
			trace.sampleToolCallId ??= toolCallIds[0];
			if (reasoning?.lookup(toolCallIds)) {
				trace.cacheHits++;
			}
		}
		if (hasThinking) {
			trace.withThinkingParts++;
		}
	}

	return trace;
}
