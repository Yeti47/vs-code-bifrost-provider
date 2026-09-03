import { BifrostConnection, BifrostModel, BifrostModelsResponse, OpenAIChatCompletionRequest, OpenAIStreamChunk } from './types';

export class BifrostApiError extends Error {
	constructor(public readonly status: number, message: string) {
		super(message || `Bifrost request failed with status ${status}`);
	}
}

async function safeText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return res.statusText;
	}
}

const MODELS_PAGE_SIZE = 200;
const MODELS_HARD_CAP = 10_000;

export async function fetchModels(connection: BifrostConnection, signal: AbortSignal): Promise<BifrostModel[]> {
	const models: BifrostModel[] = [];
	let pageToken: string | undefined;

	do {
		const url = new URL(`${connection.baseUrl}/v1/models`);
		url.searchParams.set('page_size', String(MODELS_PAGE_SIZE));
		if (pageToken) {
			url.searchParams.set('page_token', pageToken);
		}

		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${connection.apiKey}` },
			signal
		});

		if (!res.ok) {
			throw new BifrostApiError(res.status, await safeText(res));
		}

		const body = await res.json() as BifrostModelsResponse;
		models.push(...(body.data ?? []));
		pageToken = body.next_page_token || undefined;
	} while (pageToken && models.length < MODELS_HARD_CAP);

	return models;
}

export async function* streamChatCompletion(
	connection: BifrostConnection,
	request: OpenAIChatCompletionRequest,
	sessionId: string,
	signal: AbortSignal
): AsyncGenerator<OpenAIStreamChunk, void, undefined> {
	const res = await fetch(`${connection.baseUrl}/v1/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${connection.apiKey}`,
			// Forwarded verbatim to the upstream provider by Bifrost (x-bf-eh-* is stripped
			// and re-emitted); OpenCode Go requires one stable id per conversation. See
			// sessionTracking.ts for how sessionId is derived.
			'x-bf-eh-x-opencode-session': sessionId
		},
		body: JSON.stringify(request),
		signal
	});

	if (!res.ok || !res.body) {
		throw new BifrostApiError(res.status, await safeText(res));
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });

			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);

				if (!line.startsWith('data:')) {
					continue;
				}
				const data = line.slice('data:'.length).trim();
				if (data === '[DONE]') {
					return;
				}
				if (!data) {
					continue;
				}
				try {
					yield JSON.parse(data) as OpenAIStreamChunk;
				} catch {
					// Ignore malformed/partial chunks rather than aborting the whole stream.
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}
