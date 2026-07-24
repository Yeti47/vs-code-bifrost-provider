import * as vscode from 'vscode';
import { OpenAIContentPart, OpenAIMessage, OpenAITool, OpenAIToolCall } from './types';

export function toOpenAIMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIMessage[] {
	const result: OpenAIMessage[] = [];
	for (const message of messages) {
		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			result.push(convertAssistantMessage(message));
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

function convertAssistantMessage(message: vscode.LanguageModelChatRequestMessage): OpenAIMessage {
	const textParts: string[] = [];
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
		}
	}

	const openAiMessage: OpenAIMessage = {
		role: 'assistant',
		content: textParts.length > 0 ? textParts.join('') : null
	};
	if (toolCalls.length > 0) {
		openAiMessage.tool_calls = toolCalls;
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
