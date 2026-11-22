import * as vscode from 'vscode';
import { BifrostApiError, fetchModels, streamChatCompletion } from './bifrostClient';
import { tokenToSignal } from './cancellation';
import { getConnection, promptForConnection } from './config';
import { BifrostDatasheet, DatasheetEntry } from './datasheet';
import { formatModelName, formatProviderName } from './displayNames';
import { extractPlainText, toOpenAIMessages, toOpenAITools, toolModeToChoice } from './messageConversion';
import { slugifyModelId } from './modelSlug';
import { ActiveProfileSource } from './profiles';
import { resolveSessionId } from './sessionTracking';
import { createThinkingPart } from './thinking';
import { BifrostModel, OpenAIChatCompletionRequest } from './types';

const MODEL_CACHE_TTL_MS = 60_000;

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

	private cache: ModelCache | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly profiles: ActiveProfileSource
	) {
		this.datasheet = new BifrostDatasheet(context);
		this.disposables.push(this.datasheet, this.datasheet.onDidUpdate(() => this.invalidateCache()));
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
			const siblings = buildSiblingIndex(models);
			const mapped = await Promise.all(
				models.map((model) => this.toLanguageModelChatInformation(model, overrides, siblings, token))
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

		const tools = toOpenAITools(options.tools);
		const request: OpenAIChatCompletionRequest = {
			model: model.id,
			messages: toOpenAIMessages(messages),
			stream: true,
			tools,
			tool_choice: tools ? toolModeToChoice(options.toolMode) : undefined
		};
		const requestContext = {
			sessionId: sendOpenCodeSessionHeader() ? resolveSessionId(messages, options.modelOptions) : undefined,
			profile: this.profiles.getActiveProfile()
		};

		const toolCallBuffers = new Map<number, ToolCallBuffer>();

		for await (const chunk of streamChatCompletion(connection, request, requestContext, tokenToSignal(token))) {
			const choice = chunk.choices?.[0];
			if (!choice) {
				continue;
			}

			const reasoning = choice.delta?.reasoning_content || choice.delta?.reasoning;
			if (reasoning) {
				// Undefined on hosts without the (still proposed) thinking part API; harmless to skip.
				const part = createThinkingPart(reasoning);
				if (part) {
					progress.report(part);
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
				for (const call of toolCallBuffers.values()) {
					progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, safeParseJson(call.arguments)));
				}
				toolCallBuffers.clear();
			}
		}
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
		siblings: SiblingIndex,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation> {
		const family = model.id.includes('/') ? model.id.split('/')[0] : model.id;
		// Looked up lazily: only models Bifrost reports no metadata for need the registry.
		let datasheetEntry: Promise<DatasheetEntry | undefined> | undefined;
		const datasheet = () => (datasheetEntry ??= this.datasheet.lookup(model.id, token));
		const resolved = await this.resolveMaxInputTokens(model, family, contextSizeOverrides, siblings, datasheet);
		const { maxInputTokens } = resolved;
		const maxOutputTokens = model.max_output_tokens ?? Math.min(maxInputTokens, 4096);
		// Bifrost only carries rich catalog metadata (supported_parameters, etc.) for some providers
		// (e.g. its OpenRouter passthrough). When it's simply absent, assume tool calling works rather
		// than hiding the model from Copilot's agent/edit mode, which filters on this capability.
		const toolCalling = model.supported_parameters
			? model.supported_parameters.some((p) => p === 'tools' || p === 'tool_choice')
			: true;
		const imageInput = await resolveImageInput(model, siblings, datasheet);

		const tooltip = this.describeContextSize(family, resolved);

		return {
			id: model.id,
			name: `${formatProviderName(family)}: ${formatModelName(model.id, model.name)}`,
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
		siblings: SiblingIndex,
		datasheet: () => Promise<DatasheetEntry | undefined>
	): Promise<ResolvedContextSize> {
		if (model.max_input_tokens) {
			return { maxInputTokens: model.max_input_tokens, source: 'bifrost' };
		}
		if (model.context_length) {
			return { maxInputTokens: model.context_length, source: 'bifrost' };
		}

		const sibling = siblings.context.get(slugifyModelId(model.id));
		if (sibling) {
			return { maxInputTokens: sibling.maxInputTokens, source: 'sibling', sourceFamily: sibling.family };
		}

		const fromDatasheet = (await datasheet())?.maxInputTokens;
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

/** What other providers in this same fetch report directly, keyed by base model name. */
interface SiblingIndex {
	/** Best context size any provider reported. */
	context: Map<string, SiblingContextEntry>;
	/** Whether any provider that reports input modalities lists image input. */
	imageInput: Map<string, boolean>;
}

function buildSiblingIndex(models: readonly BifrostModel[]): SiblingIndex {
	const context = new Map<string, SiblingContextEntry>();
	const imageInput = new Map<string, boolean>();
	for (const model of models) {
		const slug = slugifyModelId(model.id);

		const modalities = model.architecture?.input_modalities;
		if (modalities) {
			imageInput.set(slug, (imageInput.get(slug) ?? false) || modalities.includes('image'));
		}

		const maxInputTokens = model.max_input_tokens ?? model.context_length;
		if (!maxInputTokens) {
			continue;
		}
		const existing = context.get(slug);
		if (!existing || maxInputTokens > existing.maxInputTokens) {
			const family = model.id.includes('/') ? model.id.split('/')[0] : model.id;
			context.set(slug, { maxInputTokens, family });
		}
	}
	return { context, imageInput };
}

/**
 * Most Bifrost providers (Anthropic, custom OpenAI-compatible ones, ...) report no input
 * modalities, so absent metadata is not a "no": fall back to another provider's copy of the same
 * model, then to Bifrost's public registry. Only a model nothing knows about is assumed text-only.
 */
async function resolveImageInput(
	model: BifrostModel,
	siblings: SiblingIndex,
	datasheet: () => Promise<DatasheetEntry | undefined>
): Promise<boolean> {
	const modalities = model.architecture?.input_modalities;
	if (modalities) {
		return modalities.includes('image');
	}
	const fromSibling = siblings.imageInput.get(slugifyModelId(model.id));
	if (fromSibling !== undefined) {
		return fromSibling;
	}
	return (await datasheet())?.vision ?? false;
}

/**
 * Bifrost before v2.6.0 doesn't manage OpenCode Go sessions itself, so the extension can send its
 * own per-conversation id instead. Off by default: v2.6.0+ does this natively.
 */
function sendOpenCodeSessionHeader(): boolean {
	return vscode.workspace.getConfiguration('bifrost').get<boolean>('sendOpenCodeSessionHeader', false);
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
