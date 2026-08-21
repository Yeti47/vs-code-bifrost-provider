import * as vscode from 'vscode';
import { BifrostApiError, fetchModels, streamChatCompletion } from './bifrostClient';
import { tokenToSignal } from './cancellation';
import { getConnection, promptForConnection } from './config';
import { BifrostDatasheet } from './datasheet';
import { Diagnostics, formatFields } from './diagnostics';
import { extractPlainText, toOpenAIMessages, toOpenAITools, toolModeToChoice, traceReasoningReplay } from './messageConversion';
import { slugifyModelId } from './modelSlug';
import { ReasoningAccumulator } from './reasoning';
import { ReasoningCache } from './reasoningCache';
import { pickRoutingTarget } from './routing';
import { createThinkingPart, isThinkingPart, isThinkingPartApiAvailable } from './thinking';
import { BifrostModel, OpenAIChatCompletionRequest } from './types';

const MODEL_CACHE_TTL_MS = 60_000;
/** Global-state key holding the reasoning dialect learned per model id. */
const DIALECT_STATE_KEY = 'bifrost.reasoningDialects';
/**
 * Global-state key holding a small, most-recent slice of captured reasoning. Without this, a reload
 * mid-conversation wipes the in-memory cache but the chat client still replays every earlier
 * tool-call turn on the next request — any of those turns now missing reasoning can be enough for
 * DeepSeek to reject the request, so surviving a reload matters, not just surviving one process.
 */
const ENTRIES_STATE_KEY = 'bifrost.reasoningEntries';

interface ModelCache {
	connectionKey: string;
	timestamp: number;
	models: vscode.LanguageModelChatInformation[];
}

interface ToolCallBuffer {
	id: string;
	name: string;
	arguments: string;
}

export class BifrostChatModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
	private readonly didChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.didChangeEmitter.event;

	private readonly datasheet: BifrostDatasheet;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly reasoningCache = new ReasoningCache();

	private cache: ModelCache | undefined;

	private readonly diagnostics = new Diagnostics();

	constructor(private readonly context: vscode.ExtensionContext) {
		// A resumed conversation can contain reasoning from before a window reload. Without the
		// remembered dialect we would treat those models as never having produced reasoning and stop
		// replaying it, which is exactly when DeepSeek starts rejecting the request.
		this.reasoningCache.hydrateDialects(context.globalState?.get(DIALECT_STATE_KEY) ?? {});
		this.reasoningCache.hydrateEntries(context.globalState?.get(ENTRIES_STATE_KEY) ?? {});
		this.datasheet = new BifrostDatasheet(context);
		this.disposables.push(this.datasheet, this.diagnostics, this.datasheet.onDidUpdate(() => this.invalidateCache()));
	}

	dispose(): void {
		this.didChangeEmitter.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	invalidateCache(): void {
		this.cache = undefined;
		this.didChangeEmitter.fire();
	}

	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		let connection = await getConnection(this.context);
		if (!connection) {
			if (options.silent) {
				return [];
			}
			connection = await promptForConnection(this.context);
			if (!connection) {
				return [];
			}
		}

		const connectionKey = `${connection.baseUrl}::${connection.apiKey}`;
		if (this.cache?.connectionKey === connectionKey && Date.now() - this.cache.timestamp < MODEL_CACHE_TTL_MS) {
			return this.cache.models;
		}

		try {
			const models = await fetchModels(connection, tokenToSignal(token));
			const overrides = vscode.workspace.getConfiguration('bifrost').get<Record<string, number>>('contextSizeOverrides', {});
			const siblingContext = buildSiblingContextIndex(models);
			const mapped = await Promise.all(
				models.map((model) => this.toLanguageModelChatInformation(model, overrides, siblingContext, token))
			);
			this.cache = { connectionKey, timestamp: Date.now(), models: mapped };
			return mapped;
		} catch (err) {
			if (!options.silent) {
				await this.reportDiscoveryError(err);
			}
			return this.cache?.models ?? [];
		}
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const connection = await getConnection(this.context);
		if (!connection) {
			throw new Error('Bifrost is not configured. Run "Configure Bifrost Connection" first.');
		}

		const reasoningCache = this.reasoningCache.forModel(model.id);
		const tools = toOpenAITools(options.tools);
		const outgoing = toOpenAIMessages(messages, reasoningCache);
		const request: OpenAIChatCompletionRequest = {
			model: model.id,
			messages: outgoing,
			stream: true,
			tools,
			tool_choice: tools ? toolModeToChoice(options.toolMode) : undefined
		};

		// Derived from the first message, which stays constant for a conversation's whole lifetime,
		// so every turn of the same conversation picks the same routing target. See routing.ts.
		const routingTargets = vscode.workspace.getConfiguration('bifrost').get<Record<string, number>>('routingTargets', {});
		const routingIdentity = messages.length > 0 ? extractPlainText(messages[0]) : '';
		const routingTarget = pickRoutingTarget(routingIdentity, routingTargets);

		// `historyThinkingParts` tells us whether the chat client replays reasoning back to us; when it
		// is 0 but `sentReasoning` is not, the fallback cache is the thing keeping DeepSeek happy.
		const historyThinkingParts = messages.reduce(
			(total, message) => total + message.content.filter((part) => isThinkingPart(part)).length,
			0
		);
		// `sentReasoning` alone was not enough to explain a live report of it staying at 0 even with
		// historyThinkingParts > 0: this traces the two paths (cache-by-id, dialect-gated replay)
		// individually so a real log can show which one is failing and why.
		const trace = traceReasoningReplay(messages, reasoningCache);
		this.diagnostics.log(`request ${formatFields({
			model: model.id,
			messages: outgoing.length,
			historyThinkingParts,
			// Must check every dialect: counting only `reasoning_content` reports zero for the
			// OpenRouter-style gateways that populate `reasoning` instead.
			sentReasoning: outgoing.filter(
				(message) => message.reasoning_content || message.reasoning || message.reasoning_details
			).length,
			thinkingPartApi: isThinkingPartApiAvailable() ? 'available' : 'missing',
			assistantMsgs: trace.assistantMessages,
			withToolCalls: trace.withToolCalls,
			withThinkingParts: trace.withThinkingParts,
			cacheHits: trace.cacheHits,
			dialectKnown: trace.dialectKnown,
			historyToolCallId: trace.sampleToolCallId ?? 'none',
			routingTarget: routingTarget ?? 'none'
		})}`);

		const toolCallBuffers = new Map<number, ToolCallBuffer>();
		const reasoning = new ReasoningAccumulator();
		let reasoningChars = 0;
		let thinkingPartsReported = 0;
		let toolCallsReported = 0;
		let sampleAssignedToolCallId: string | undefined;
		const finishReasons: string[] = [];
		// Every field name the upstream actually sent on `delta`. Gateways disagree on what to call
		// reasoning (`reasoning_content`, `reasoning`, `reasoning_details`, ...), so this is how we
		// find out whether reasoning is absent or merely arriving under a name we do not read.
		const deltaKeys = new Set<string>();

		const flushToolCalls = (): void => {
			if (toolCallBuffers.size === 0) {
				return;
			}
			const calls = [...toolCallBuffers.values()];
			toolCallBuffers.clear();
			sampleAssignedToolCallId ??= calls[0]?.id;
			// Record before reporting: once these ids reach the client they can come back in history,
			// and DeepSeek needs the matching reasoning replayed alongside them.
			reasoningCache.remember(calls.map((call) => call.id), reasoning.snapshot());
			for (const call of calls) {
				progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, safeParseJson(call.arguments)));
			}
			toolCallsReported += calls.length;
		};

		for await (const chunk of streamChatCompletion(connection, request, tokenToSignal(token), routingTarget)) {
			const choice = chunk.choices?.[0];
			if (!choice) {
				continue;
			}

			if (choice.finish_reason) {
				finishReasons.push(choice.finish_reason);
			}

			for (const key of Object.keys(choice.delta ?? {})) {
				deltaKeys.add(key);
			}

			const reasoningFragment = reasoning.add(choice.delta);
			if (reasoningFragment) {
				reasoningChars += reasoningFragment.length;
				// VS Code merges consecutive thinking parts, so streaming fragments straight through
				// keeps the reasoning UI live. Undefined on hosts without the thinking part API.
				const part = createThinkingPart(reasoningFragment);
				if (part) {
					progress.report(part);
					thinkingPartsReported++;
				}
			}

			if (choice.delta?.content) {
				progress.report(new vscode.LanguageModelTextPart(choice.delta.content));
			}

			for (const delta of choice.delta?.tool_calls ?? []) {
				const buffer = toolCallBuffers.get(delta.index) ?? { id: '', name: '', arguments: '' };
				if (delta.id) {
					buffer.id = delta.id;
				}
				if (delta.function?.name) {
					buffer.name += delta.function.name;
				}
				if (delta.function?.arguments) {
					buffer.arguments += delta.function.arguments;
				}
				toolCallBuffers.set(delta.index, buffer);
			}

			if (choice.finish_reason === 'tool_calls') {
				flushToolCalls();
			}
		}

		// Not every provider ends a tool-calling turn with `finish_reason: 'tool_calls'` — some send
		// `stop`, or omit it entirely. Without this the buffered calls would be silently dropped.
		flushToolCalls();

		const captured = reasoning.snapshot();
		if (captured) {
			reasoningCache.noteDialect(captured.textField);
			void this.context.globalState?.update(DIALECT_STATE_KEY, this.reasoningCache.exportDialects());
			void this.context.globalState?.update(ENTRIES_STATE_KEY, this.reasoningCache.exportEntries());
		}

		this.diagnostics.log(`response ${formatFields({
			model: model.id,
			reasoningChars,
			reasoningField: captured?.textField ?? 'none',
			reasoningDetails: reasoning.describeDetails(),
			thinkingPartsReported,
			toolCalls: toolCallsReported,
			// Compare against `historyToolCallId` on a later request line for the same conversation:
			// if they never match, the chat client is not preserving tool-call ids through history,
			// which would explain the id-keyed cache never hitting.
			assignedToolCallId: sampleAssignedToolCallId ?? 'none',
			finishReasons: finishReasons.length > 0 ? finishReasons.join(',') : 'none',
			deltaKeys: deltaKeys.size > 0 ? [...deltaKeys].sort().join(',') : 'none'
		})}`);
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken
	): Promise<number> {
		const content = typeof text === 'string' ? text : extractPlainText(text);
		return Math.ceil(content.length / 4);
	}

	private async reportDiscoveryError(err: unknown): Promise<void> {
		const message = err instanceof BifrostApiError
			? describeApiError(err)
			: `Could not reach Bifrost: ${err instanceof Error ? err.message : String(err)}`;
		const choice = await vscode.window.showErrorMessage(message, 'Reconfigure');
		if (choice === 'Reconfigure') {
			await vscode.commands.executeCommand('bifrost.manage');
		}
	}

	private async toLanguageModelChatInformation(
		model: BifrostModel,
		contextSizeOverrides: Record<string, number>,
		siblingContext: Map<string, SiblingContextEntry>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation> {
		const family = model.id.includes('/') ? model.id.split('/')[0] : model.id;
		const resolved = await this.resolveMaxInputTokens(model, family, contextSizeOverrides, siblingContext, token);
		const { maxInputTokens } = resolved;
		const maxOutputTokens = model.max_output_tokens ?? Math.min(maxInputTokens, 4096);
		// Bifrost only carries rich catalog metadata (supported_parameters, etc.) for some providers
		// (e.g. its OpenRouter passthrough). When it's simply absent, assume tool calling works rather
		// than hiding the model from Copilot's agent/edit mode, which filters on this capability.
		const toolCalling = model.supported_parameters
			? model.supported_parameters.some((p) => p === 'tools' || p === 'tool_choice')
			: true;
		const imageInput = model.architecture?.input_modalities?.includes('image') ?? false;

		const tooltip = this.describeContextSize(family, resolved);

		return {
			id: model.id,
			name: `${family}: ${model.name ?? model.id}`,
			family,
			version: '1.0.0',
			maxInputTokens,
			maxOutputTokens,
			tooltip,
			detail: model.id,
			capabilities: { toolCalling, imageInput }
		};
	}

	private async resolveMaxInputTokens(
		model: BifrostModel,
		provider: string,
		overrides: Record<string, number>,
		siblingContext: Map<string, SiblingContextEntry>,
		token: vscode.CancellationToken
	): Promise<ResolvedContextSize> {
		if (model.max_input_tokens) {
			return { maxInputTokens: model.max_input_tokens, source: 'bifrost' };
		}
		if (model.context_length) {
			return { maxInputTokens: model.context_length, source: 'bifrost' };
		}

		const sibling = siblingContext.get(slugifyModelId(model.id));
		if (sibling) {
			return { maxInputTokens: sibling.maxInputTokens, source: 'sibling', sourceFamily: sibling.family };
		}

		const fromDatasheet = await this.datasheet.lookup(model.id, token);
		if (fromDatasheet) {
			return { maxInputTokens: fromDatasheet, source: 'datasheet' };
		}

		const override = overrides[model.id] ?? overrides[provider];
		if (override !== undefined) {
			return { maxInputTokens: override, source: 'override' };
		}

		return { maxInputTokens: DEFAULT_MAX_INPUT_TOKENS, source: 'default' };
	}

	private describeContextSize(family: string, resolved: ResolvedContextSize): string {
		const tokens = resolved.maxInputTokens.toLocaleString();
		switch (resolved.source) {
			case 'default':
				return `${family} · context size unknown, using ${tokens} default — set "bifrost.contextSizeOverrides" to correct it`;
			case 'sibling':
				return `${family} · ${tokens} token context, cross-referenced from ${resolved.sourceFamily}'s copy of this same model`;
			case 'datasheet': {
				const caveat = family === 'ollama'
					? ' (this is the model\'s architectural max — your Ollama server may be configured with a smaller context)'
					: '';
				return `${family} · ${tokens} token context, estimated from Bifrost's public model registry${caveat}`;
			}
			default:
				return `${family} · ${tokens} token context`;
		}
	}
}

interface SiblingContextEntry {
	maxInputTokens: number;
	family: string;
}

/** Maps each base model name to the best context size any provider in this fetch reported directly. */
function buildSiblingContextIndex(models: readonly BifrostModel[]): Map<string, SiblingContextEntry> {
	const index = new Map<string, SiblingContextEntry>();
	for (const model of models) {
		const maxInputTokens = model.max_input_tokens ?? model.context_length;
		if (!maxInputTokens) {
			continue;
		}
		const slug = slugifyModelId(model.id);
		const existing = index.get(slug);
		if (!existing || maxInputTokens > existing.maxInputTokens) {
			const family = model.id.includes('/') ? model.id.split('/')[0] : model.id;
			index.set(slug, { maxInputTokens, family });
		}
	}
	return index;
}

const DEFAULT_MAX_INPUT_TOKENS = 4096;
type ContextSizeSource = 'bifrost' | 'sibling' | 'datasheet' | 'override' | 'default';
type ResolvedContextSize =
	| { maxInputTokens: number; source: 'sibling'; sourceFamily: string }
	| { maxInputTokens: number; source: Exclude<ContextSizeSource, 'sibling'> };

function describeApiError(err: BifrostApiError): string {
	if (err.status === 401 || err.status === 403) {
		return 'Bifrost rejected the request: check that your virtual key is correct.';
	}
	return `Bifrost request failed (${err.status}): ${err.message}`;
}

function safeParseJson(text: string): object {
	if (!text) {
		return {};
	}
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
}
