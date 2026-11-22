import * as vscode from 'vscode';
import { tokenToSignal } from './cancellation';
import { slugifyModelId } from './modelSlug';

const DATASHEET_URL = 'https://getbifrost.ai/datasheet/model-parameters';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE_NAME = 'datasheet-index.json';
// Bump when the index shape changes; a cache with another version is ignored and refetched.
const INDEX_SCHEMA_VERSION = 2;
const FETCH_TIMEOUT_MS = 30_000;
const INLINE_WAIT_MS = 8_000;

/** What the registry knows about one base model name, merged across every provider listing it. */
export interface DatasheetEntry {
	/** Largest max input tokens any listing reports. */
	maxInputTokens?: number;
	/** True if any listing reports image input, false if listings only report its absence. */
	vision?: boolean;
}

interface DatasheetIndex {
	schemaVersion: number;
	fetchedAt: number;
	/** Lowercased last path segment of a model id -> merged entry. */
	entries: Record<string, DatasheetEntry>;
}

interface RawDatasheetEntry {
	mode?: string;
	max_input_tokens?: number;
	supports_vision?: boolean;
	supports_image_input?: boolean;
	supported_modalities?: string[];
}

/**
 * Best-effort lookup against Bifrost's public model registry (getbifrost.ai/datasheet), used to
 * fill in context sizes and image input support for models that a given Bifrost instance reports no metadata for (e.g.
 * ollama, custom OpenAI-compatible providers). Matches by base model name only, ignoring which
 * provider the registry happens to list it under, since the same open-weight model is often
 * cataloged under an unrelated host.
 */
export class BifrostDatasheet implements vscode.Disposable {
	private readonly didUpdateEmitter = new vscode.EventEmitter<void>();
	readonly onDidUpdate = this.didUpdateEmitter.event;

	private memoryIndex: DatasheetIndex | undefined;
	private inFlight: Promise<DatasheetIndex | undefined> | undefined;

	constructor(private readonly context: vscode.ExtensionContext) { }

	dispose(): void {
		this.didUpdateEmitter.dispose();
	}

	/**
	 * Resolves quickly from cache when possible. On a cold cache this waits briefly for the
	 * (one-time, ~daily) network fetch, then gives up and lets it finish in the background —
	 * `onDidUpdate` fires once it does, so a subsequent listing picks up the real value.
	 */
	async lookup(modelId: string, token: vscode.CancellationToken): Promise<DatasheetEntry | undefined> {
		const index = await this.getIndexWithBoundedWait(token);
		return index?.entries[slugifyModelId(modelId)];
	}

	private async getIndexWithBoundedWait(token: vscode.CancellationToken): Promise<DatasheetIndex | undefined> {
		if (this.memoryIndex && Date.now() - this.memoryIndex.fetchedAt < CACHE_TTL_MS) {
			return this.memoryIndex;
		}

		const refresh = this.ensureRefreshing(token);
		const timedOut = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), INLINE_WAIT_MS));
		const result = await Promise.race([refresh, timedOut]);
		return result ?? this.memoryIndex;
	}

	private ensureRefreshing(token: vscode.CancellationToken): Promise<DatasheetIndex | undefined> {
		if (!this.inFlight) {
			this.inFlight = this.refresh(token).finally(() => {
				this.inFlight = undefined;
			});
		}
		return this.inFlight;
	}

	private async refresh(token: vscode.CancellationToken): Promise<DatasheetIndex | undefined> {
		const cached = this.memoryIndex ?? await this.loadDiskCache();
		if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
			this.memoryIndex = cached;
			return cached;
		}

		try {
			const fresh = await this.fetchAndBuildIndex(token);
			this.memoryIndex = fresh;
			this.didUpdateEmitter.fire();
			void this.saveDiskCache(fresh);
			return fresh;
		} catch {
			// Fall back to a stale on-disk cache rather than nothing at all.
			this.memoryIndex = cached;
			return cached;
		}
	}

	private async fetchAndBuildIndex(token: vscode.CancellationToken): Promise<DatasheetIndex> {
		const signal = AbortSignal.any([tokenToSignal(token), AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
		const res = await fetch(DATASHEET_URL, { signal });
		if (!res.ok) {
			throw new Error(`Bifrost datasheet fetch failed: ${res.status}`);
		}
		const raw = await res.json() as Record<string, RawDatasheetEntry>;

		const entries: Record<string, DatasheetEntry> = {};
		for (const [key, value] of Object.entries(raw)) {
			if (value.mode !== 'chat') {
				continue;
			}
			const vision = readVision(value);
			if (!value.max_input_tokens && vision === undefined) {
				continue;
			}
			const slug = slugifyModelId(key);
			const entry = entries[slug] ?? {};
			if (value.max_input_tokens) {
				entry.maxInputTokens = Math.max(entry.maxInputTokens ?? 0, value.max_input_tokens);
			}
			if (vision !== undefined) {
				entry.vision = entry.vision || vision;
			}
			entries[slug] = entry;
		}

		return { schemaVersion: INDEX_SCHEMA_VERSION, fetchedAt: Date.now(), entries };
	}

	private get cacheUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.context.globalStorageUri, CACHE_FILE_NAME);
	}

	private async loadDiskCache(): Promise<DatasheetIndex | undefined> {
		try {
			const bytes = await vscode.workspace.fs.readFile(this.cacheUri);
			const index = JSON.parse(Buffer.from(bytes).toString('utf8')) as DatasheetIndex;
			return index.schemaVersion === INDEX_SCHEMA_VERSION ? index : undefined;
		} catch {
			return undefined;
		}
	}

	private async saveDiskCache(index: DatasheetIndex): Promise<void> {
		try {
			await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
			await vscode.workspace.fs.writeFile(this.cacheUri, Buffer.from(JSON.stringify(index)));
		} catch {
			// Non-fatal: worst case we refetch next time.
		}
	}
}

function readVision(entry: RawDatasheetEntry): boolean | undefined {
	if (entry.supports_vision !== undefined || entry.supports_image_input !== undefined) {
		return entry.supports_vision === true || entry.supports_image_input === true;
	}
	if (entry.supported_modalities) {
		return entry.supported_modalities.includes('image');
	}
	return undefined;
}
