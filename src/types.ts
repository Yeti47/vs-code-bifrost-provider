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
			tool_calls?: OpenAIStreamDeltaToolCall[];
		};
		finish_reason?: string | null;
	}>;
}
