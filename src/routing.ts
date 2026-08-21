/**
 * Deterministic, weighted target selection for one conversation.
 *
 * Bifrost's weighted Routing Rules re-roll on every request — there is no session/conversation
 * identity in the selection, so a multi-turn conversation can hop between targets mid-stream. For
 * targets that maintain server-side state tied to a specific key (DeepSeek's thinking-mode
 * continuity, provider-side prompt caching), that hop can break the conversation. See
 * https://github.com/maximhq/bifrost/issues/5409, confirmed still unresolved in any released
 * version as of Bifrost v1.6.11.
 *
 * This works around it from the client: the same conversation always picks the same label, so a
 * Bifrost Routing Rule keyed on an exact header match (rather than Bifrost's own weighted targets)
 * stays pinned to one provider/key for the conversation's lifetime.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const HASH_SPACE = 2 ** 32;

/** FNV-1a over a string, as an unsigned 32-bit integer. Deterministic; not cryptographic. */
export function hashString(text: string): number {
	let hash = FNV_OFFSET_BASIS;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, FNV_PRIME);
	}
	return hash >>> 0;
}

/**
 * Picks one label for the given conversation identity, proportional to the supplied weights.
 *
 * The same `identity` always yields the same label, so callers should derive it from something
 * stable for the lifetime of a conversation (e.g. the first message's text) rather than anything
 * that changes turn to turn. Weights are relative, not required to sum to 1 or to any fixed total.
 *
 * Returns `undefined` when there is nothing to pick from (no positive-weighted labels) — callers
 * should treat that as "routing is not configured" and skip sending anything.
 */
export function pickRoutingTarget(identity: string, weights: Readonly<Record<string, number>>): string | undefined {
	const entries = Object.entries(weights)
		.filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
		// Sorted so the bucket order — and therefore which label a given identity lands on — does not
		// depend on incidental JSON key order in the user's settings.
		.sort(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) {
		return undefined;
	}

	const totalWeight = entries.reduce((sum, [, weight]) => sum + weight, 0);
	const point = (hashString(identity) / HASH_SPACE) * totalWeight;

	let cumulative = 0;
	for (const [label, weight] of entries) {
		cumulative += weight;
		if (point < cumulative) {
			return label;
		}
	}
	// Floating-point safety net: point can land exactly on (or a hair past) totalWeight.
	return entries[entries.length - 1][0];
}
