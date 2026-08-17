import { OpenAIMessage, OpenAIReasoningDetail, OpenAIStreamChunk } from './types';

/**
 * This capture/replay logic belongs upstream in Bifrost, which already documents itself as
 * normalizing reasoning across providers into `reasoning`/`reasoning_details`. It exists here
 * because that normalization does not yet cover every routing path — see
 * https://github.com/maximhq/bifrost/issues/6111, where DeepSeek's reasoning-replay fix is wired
 * up for the direct DeepSeek provider but not for requests routed through OpenCode Go, which is
 * exactly the failure this file works around. Bifrost's own tracker also shows this normalization
 * regressing between point releases (maximhq/bifrost#5887), so keep this even after #6111 lands.
 */
type StreamDelta = NonNullable<NonNullable<OpenAIStreamChunk['choices']>[number]['delta']>;

/**
 * `reasoning_details` fields that stream in fragments and must be concatenated. Every other field is
 * metadata that repeats or arrives once, and is overwritten instead.
 */
const CONTENT_DETAIL_FIELDS = new Set(['text', 'summary', 'data']);

/** Which spelling of "reasoning" the upstream used, so we can answer in the same dialect. */
export type ReasoningTextField = 'reasoning_content' | 'reasoning';

/**
 * Everything we captured about one assistant turn's reasoning, in a form that can be replayed on a
 * later request. `details` is kept verbatim because it may carry provider signatures that only
 * validate unmodified.
 */
export interface CapturedReasoning {
	text: string;
	textField: ReasoningTextField;
	details?: OpenAIReasoningDetail[];
}

/**
 * Accumulates reasoning across the deltas of a single streamed response.
 *
 * Providers disagree on both the field name and the structure: DeepSeek's own API streams plain text
 * in `reasoning_content`, while OpenRouter-style gateways stream `reasoning` text alongside a
 * structured `reasoning_details` array whose entries arrive in fragments identified by `index`.
 */
export class ReasoningAccumulator {
	private text = '';
	private field: ReasoningTextField = 'reasoning_content';
	private readonly details = new Map<number, OpenAIReasoningDetail>();
	private nextImplicitIndex = 0;

	/**
	 * Folds one delta in and returns the text fragment it contributed, so the caller can stream that
	 * fragment onward as a thinking part. Returns an empty string when the delta carried no text.
	 */
	add(delta: StreamDelta | undefined): string {
		if (!delta) {
			return '';
		}

		let fragment = '';
		if (delta.reasoning_content) {
			fragment = delta.reasoning_content;
			this.field = 'reasoning_content';
		} else if (delta.reasoning) {
			fragment = delta.reasoning;
			this.field = 'reasoning';
		}
		this.text += fragment;

		for (const detail of delta.reasoning_details ?? []) {
			this.mergeDetail(detail);
		}

		return fragment;
	}

	/** The captured reasoning, or `undefined` if this turn produced none. */
	snapshot(): CapturedReasoning | undefined {
		if (!this.text && this.details.size === 0) {
			return undefined;
		}
		const details = [...this.details.entries()]
			.sort(([a], [b]) => a - b)
			.map(([, detail]) => detail);
		return {
			text: this.text,
			textField: this.field,
			details: details.length > 0 ? details : undefined
		};
	}

	/**
	 * Structural summary for diagnostics: entry count, `type` values and field names only. Never
	 * includes reasoning text or signatures.
	 */
	describeDetails(): string {
		if (this.details.size === 0) {
			return 'none';
		}
		const types = new Set<string>();
		const keys = new Set<string>();
		for (const detail of this.details.values()) {
			types.add(typeof detail.type === 'string' ? detail.type : 'untyped');
			for (const key of Object.keys(detail)) {
				keys.add(key);
			}
		}
		return `${this.details.size}[${[...types].sort().join('|')}:${[...keys].sort().join('|')}]`;
	}

	/**
	 * Fragments of the same entry share an `index`. Only the content-bearing fields accumulate;
	 * everything else takes the latest non-null value, because discriminators like `type` repeat on
	 * every fragment (concatenating them yields "reasoning.textreasoning.text") while terminal fields
	 * like `signature` arrive on a later fragment than the text they sign.
	 */
	private mergeDetail(incoming: OpenAIReasoningDetail): void {
		const index = typeof incoming.index === 'number' ? incoming.index : this.nextImplicitIndex++;
		const existing = this.details.get(index);
		if (!existing) {
			this.details.set(index, { ...incoming, index });
			return;
		}
		for (const [key, value] of Object.entries(incoming)) {
			if (key === 'index' || value === null || value === undefined) {
				continue;
			}
			const current = existing[key];
			const concatenates = CONTENT_DETAIL_FIELDS.has(key) && typeof current === 'string' && typeof value === 'string';
			existing[key] = concatenates ? (current as string) + value : value;
		}
	}
}

/** Attaches captured reasoning to an outgoing assistant message, in the dialect it arrived in. */
export function applyReasoning(message: OpenAIMessage, captured: CapturedReasoning): void {
	if (captured.text) {
		message[captured.textField] = captured.text;
	}
	if (captured.details && captured.details.length > 0) {
		message.reasoning_details = captured.details;
	}
}
