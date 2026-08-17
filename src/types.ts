export interface BifrostConnection {
	baseUrl: string;
	apiKey: string;
}

export interface BifrostModelArchitecture {
	modality?: string;
	tokenizer?: string;
	instruct_type?: string;
	input_modalities?: string[];
	output_modalities?: string[];
}

export interface BifrostModel {
	id: string;
	name?: string;
	context_length?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	architecture?: BifrostModelArchitecture;
	supported_parameters?: string[];
}

export interface BifrostModelsResponse {
	data: BifrostModel[];
	next_page_token?: string;
}

export interface OpenAIFunctionDefinition {
	name: string;
	description?: string;
	parameters?: object;
}

export interface OpenAITool {
	type: 'function';
	function: OpenAIFunctionDefinition;
}

export type OpenAIContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

export interface OpenAIToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface OpenAIMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | OpenAIContentPart[] | null;
	name?: string;
	tool_call_id?: string;
	tool_calls?: OpenAIToolCall[];
	/**
	 * Thinking-mode reasoning that the assistant produced on a previous turn. DeepSeek requires this
	 * to be replayed verbatim once the model has made a tool call, otherwise it rejects the request
	 * with "The `reasoning_content` in the thinking mode must be passed back to the API". Only set on
	 * assistant messages, and only when the model actually produced reasoning.
	 *
	 * Gateways disagree on the name: DeepSeek's own API uses `reasoning_content`, while
	 * OpenRouter-style gateways use `reasoning` plus a structured `reasoning_details`. We echo back
	 * whichever dialect the provider streamed to us. See {@link CapturedReasoning}.
	 */
	reasoning_content?: string;
	/** OpenRouter-dialect equivalent of {@link OpenAIMessage.reasoning_content}. */
	reasoning?: string;
	/** Structured reasoning, replayed verbatim so provider-specific signatures survive the round trip. */
	reasoning_details?: OpenAIReasoningDetail[];
}

/**
 * One entry of a `reasoning_details` array. The shape varies by upstream provider (text, summary and
 * encrypted variants exist, some carrying signatures), so we deliberately keep it opaque and replay
 * whatever we were given rather than modelling fields we might get wrong.
 */
export interface OpenAIReasoningDetail {
	type?: string;
	index?: number;
	[key: string]: unknown;
}

export interface OpenAIChatCompletionRequest {
	model: string;
	messages: OpenAIMessage[];
	stream: true;
	tools?: OpenAITool[];
	tool_choice?: 'auto' | 'required' | 'none';
}

export interface OpenAIStreamDeltaToolCall {
	index: number;
	id?: string;
	type?: 'function';
	function?: {
		name?: string;
		arguments?: string;
	};
}

export interface OpenAIStreamChunk {
	choices?: Array<{
		delta?: {
			content?: string | null;
			/** Thinking-mode reasoning in DeepSeek's own dialect. */
			reasoning_content?: string | null;
			/** Thinking-mode reasoning in the OpenRouter dialect used by several gateways. */
			reasoning?: string | null;
			/** Structured counterpart to `reasoning`, streamed in fragments keyed by `index`. */
			reasoning_details?: OpenAIReasoningDetail[];
			tool_calls?: OpenAIStreamDeltaToolCall[];
		};
		finish_reason?: string | null;
	}>;
}
