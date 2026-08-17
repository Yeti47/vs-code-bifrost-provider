/**
 * Remembers the reasoning that accompanied each tool call we streamed back to the chat client.
 *
 * This is the client-side half of a gap in Bifrost's own reasoning normalization — see the notice
 * at the top of ./reasoning.ts for why it lives here instead of upstream.
 *
 * `LanguageModelThinkingPart` is the carrier the chat client replays in history, but it only conveys
 * flattened text. The structured `reasoning_details` — which can carry provider signatures that only
 * validate unmodified — survives nowhere except here, so this cache is what makes a faithful replay
 * possible. DeepSeek rejects the whole request when reasoning is missing from an assistant turn that
 * made a tool call.
 *
 * Entries are keyed by model as well as tool call id: reasoning produced by one model must never be
 * replayed to another, which would send a reasoning field to a provider that rejects it.
 *
 * Bounded by total size, not just entry count. Reasoning turns can run to tens of thousands of
 * characters and the text is typically held twice (once flattened, once inside `reasoning_details`),
 * so an entry cap alone would put no real ceiling on memory.
 */

import { CapturedReasoning, ReasoningTextField } from './reasoning';

const DEFAULT_MAX_ENTRIES = 200;
/** ~4 MB of UTF-16, comfortably below anything that would matter inside the extension host. */
const DEFAULT_MAX_CHARS = 2_000_000;
/**
 * How much of the cache survives a reload. Deliberately much smaller than the runtime budget above:
 * this gets written to `globalState` after nearly every turn (the same fire-and-forget pattern
 * dialects already use), so it needs to stay cheap to serialize repeatedly rather than mirror the
 * full in-memory cache. It only needs to cover the handful of turns right at the reload boundary —
 * older gaps need a fresh conversation regardless, since nothing can reconstruct reasoning that was
 * never captured in the first place.
 */
const PERSIST_MAX_ENTRIES = 20;
const PERSIST_MAX_CHARS = 200_000;

/** A view of the cache bound to one model, so callers cannot mix reasoning across models. */
export interface ModelReasoningCache {
	remember(toolCallIds: readonly string[], reasoning: CapturedReasoning | undefined): void;
	lookup(toolCallIds: readonly string[]): CapturedReasoning | undefined;
	/** Records which spelling of "reasoning" this model streams, for replays that lack one. */
	noteDialect(field: ReasoningTextField): void;
	/**
	 * The dialect this model is known to stream, or `undefined` if we have never seen it produce
	 * reasoning at all. Callers must treat `undefined` as "send no reasoning to this model".
	 */
	dialect(): ReasoningTextField | undefined;
}

export class ReasoningCache {
	/** Insertion-ordered, so the oldest key is always the first one out when evicting. */
	private readonly entries = new Map<string, CapturedReasoning>();
	/** Charged size per key, mirroring `entries` so eviction never has to re-measure. */
	private readonly sizes = new Map<string, number>();
	/**
	 * One tiny string per model the user has actually invoked. Unbounded in principle, but an entry
	 * is a model id plus a field name, so even a very large catalogue costs a few hundred kilobytes.
	 */
	private readonly dialects = new Map<string, ReasoningTextField>();
	private totalChars = 0;

	constructor(
		private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
		private readonly maxChars: number = DEFAULT_MAX_CHARS
	) { }

	forModel(modelId: string): ModelReasoningCache {
		return {
			remember: (toolCallIds, reasoning) => this.remember(modelId, toolCallIds, reasoning),
			lookup: (toolCallIds) => this.lookup(modelId, toolCallIds),
			noteDialect: (field) => {
				this.dialects.set(modelId, field);
			},
			dialect: () => this.dialects.get(modelId)
		};
	}

	get size(): number {
		return this.entries.size;
	}

	/** Restores dialects learned in an earlier session, so a window reload does not forget them. */
	hydrateDialects(saved: Readonly<Record<string, ReasoningTextField>>): void {
		for (const [modelId, field] of Object.entries(saved ?? {})) {
			if (field === 'reasoning' || field === 'reasoning_content') {
				this.dialects.set(modelId, field);
			}
		}
	}

	exportDialects(): Record<string, ReasoningTextField> {
		return Object.fromEntries(this.dialects);
	}

	/**
	 * A small, most-recent-first slice of the cache, sized for `globalState` rather than for runtime
	 * use. Restore with {@link hydrateEntries}.
	 */
	exportEntries(): Record<string, CapturedReasoning> {
		const recent = [...this.entries.entries()].reverse();
		const out: Record<string, CapturedReasoning> = {};
		let chars = 0;
		for (const [key, reasoning] of recent) {
			if (Object.keys(out).length >= PERSIST_MAX_ENTRIES) {
				break;
			}
			const size = this.sizes.get(key) ?? measure(reasoning);
			if (chars + size > PERSIST_MAX_CHARS && Object.keys(out).length > 0) {
				break;
			}
			out[key] = reasoning;
			chars += size;
		}
		return out;
	}

	/** Restores entries saved by {@link exportEntries}, oldest-first so recency ordering is preserved. */
	hydrateEntries(saved: Readonly<Record<string, CapturedReasoning>>): void {
		for (const [key, reasoning] of Object.entries(saved ?? {}).reverse()) {
			this.setEntry(key, reasoning);
		}
	}

	/** Characters currently retained, counting shared payloads once per referencing key. */
	get charCount(): number {
		return this.totalChars;
	}

	clear(): void {
		this.entries.clear();
		this.sizes.clear();
		this.dialects.clear();
		this.totalChars = 0;
	}

	private remember(modelId: string, toolCallIds: readonly string[], reasoning: CapturedReasoning | undefined): void {
		if (!reasoning) {
			return;
		}
		for (const toolCallId of toolCallIds) {
			if (!toolCallId) {
				continue;
			}
			this.setEntry(cacheKey(modelId, toolCallId), reasoning);
		}
	}

	/**
	 * Inserts or refreshes one raw cache key, then enforces the runtime budget. Shared by `remember`
	 * (raw key built from a model id + tool call id) and `hydrateEntries` (raw key restored verbatim
	 * from a previous session, already in that same combined form).
	 */
	private setEntry(key: string, reasoning: CapturedReasoning): void {
		// Always measure the incoming payload, never reuse a stored size: a refresh can carry a
		// different-sized `reasoning` than whatever this key held before.
		const size = measure(reasoning);
		// Re-insert so refreshed entries count as most recently used.
		this.drop(key);
		this.entries.set(key, reasoning);
		this.sizes.set(key, size);
		this.totalChars += size;
		// Charging every reference to a shared payload in full means the budget over-counts rather
		// than under-counts — it evicts early, never late. Always keep the newest entry, even if it
		// alone exceeds the budget.
		while ((this.entries.size > this.maxEntries || this.totalChars > this.maxChars) && this.entries.size > 1) {
			const oldest = this.entries.keys().next();
			if (oldest.done) {
				break;
			}
			this.drop(oldest.value);
		}
	}

	private drop(key: string): void {
		if (!this.entries.delete(key)) {
			return;
		}
		this.totalChars -= this.sizes.get(key) ?? 0;
		this.sizes.delete(key);
	}

	private lookup(modelId: string, toolCallIds: readonly string[]): CapturedReasoning | undefined {
		for (const toolCallId of toolCallIds) {
			const found = this.entries.get(cacheKey(modelId, toolCallId));
			if (found) {
				return found;
			}
		}
		return undefined;
	}
}

/** Characters held by one payload, including the copy of the text usually nested in the details. */
function measure(reasoning: CapturedReasoning): number {
	let total = reasoning.text.length;
	for (const detail of reasoning.details ?? []) {
		for (const value of Object.values(detail)) {
			if (typeof value === 'string') {
				total += value.length;
			}
		}
	}
	return total;
}

function cacheKey(modelId: string, toolCallId: string): string {
	// NUL separator: neither model ids nor tool call ids contain it, so keys cannot collide.
	return `${modelId}\u0000${toolCallId}`;
}
