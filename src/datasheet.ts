import * as vscode from 'vscode';
import { tokenToSignal } from './cancellation';
import { slugifyModelId } from './modelSlug';

const DATASHEET_URL = 'https://getbifrost.ai/datasheet/model-parameters';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE_NAME = 'datasheet-index.json';
const FETCH_TIMEOUT_MS = 30_000;
const INLINE_WAIT_MS = 8_000;

interface DatasheetIndex {
	fetchedAt: number;
	/** Lowercased last path segment of a model id -> best-known max input tokens. */
	entries: Record<string, number>;
}

interface RawDatasheetEntry {
	mode?: string;
	max_input_tokens?: number;
}

/**
 * Best-effort lookup against Bifrost's public model registry (getbifrost.ai/datasheet), used to
 * fill in context sizes for models that a given Bifrost instance reports no metadata for (e.g.
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
	async lookup(modelId: string, token: vscode.CancellationToken): Promise<number | undefined> {
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

		const entries: Record<string, number> = {};
		for (const [key, value] of Object.entries(raw)) {
			if (value.mode !== 'chat' || !value.max_input_tokens) {
				continue;
			}
			const slug = slugifyModelId(key);
			entries[slug] = Math.max(entries[slug] ?? 0, value.max_input_tokens);
		}

		return { fetchedAt: Date.now(), entries };
	}

	private get cacheUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.context.globalStorageUri, CACHE_FILE_NAME);
	}

	private async loadDiskCache(): Promise<DatasheetIndex | undefined> {
		try {
			const bytes = await vscode.workspace.fs.readFile(this.cacheUri);
			return JSON.parse(Buffer.from(bytes).toString('utf8')) as DatasheetIndex;
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
