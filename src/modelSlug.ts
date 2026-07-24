/**
 * Normalizes a Bifrost model id down to its base model name, ignoring which provider serves it,
 * e.g. "openrouter/moonshotai/kimi-k3" and "opencode-go/kimi-k3" both slugify to "kimi-k3".
 * Used to cross-reference the same underlying model across providers/registries.
 */
export function slugifyModelId(modelId: string): string {
	const segments = modelId.split('/');
	return segments[segments.length - 1].toLowerCase();
}
