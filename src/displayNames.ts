/**
 * Readable names for the model picker. Bifrost provider keys and model ids are slugs
 * (e.g. "github-copilot", "claude-sonnet-5.5"), and many providers (custom OpenAI-compatible
 * ones, Ollama) report no display name, so labels are derived from those slugs.
 */

// Words whose casing can't be derived by capitalizing the first letter.
const KNOWN_WORDS: Record<string, string> = {
	ai: 'AI',
	api: 'API',
	aws: 'AWS',
	deepinfra: 'DeepInfra',
	deepseek: 'DeepSeek',
	github: 'GitHub',
	glm: 'GLM',
	gpt: 'GPT',
	huggingface: 'Hugging Face',
	llm: 'LLM',
	lmstudio: 'LM Studio',
	minimax: 'MiniMax',
	oss: 'OSS',
	openai: 'OpenAI',
	opencode: 'OpenCode',
	openrouter: 'OpenRouter',
	sgl: 'SGLang',
	vllm: 'vLLM',
	xai: 'xAI'
};

/** "github-copilot" -> "GitHub Copilot", "openrouter" -> "OpenRouter". */
export function formatProviderName(provider: string): string {
	return humanizeSlug(provider);
}

/**
 * The model part of a picker label. Uses the name Bifrost reports when it is a real display
 * name, otherwise derives one from the last segment of the id
 * (e.g. "github-copilot/claude-sonnet-5.5" -> "Claude Sonnet 5.5").
 */
export function formatModelName(modelId: string, reportedName: string | undefined): string {
	const segments = modelId.split('/');
	const lastSegment = segments[segments.length - 1];
	const name = reportedName?.trim();
	// Some providers echo the id back as the name; that is no more readable than the id itself.
	if (name && !name.includes('/') && name !== lastSegment) {
		return name;
	}
	return humanizeSlug(lastSegment);
}

function humanizeSlug(slug: string): string {
	const words = slug.split(/[-_\s]+/).filter(Boolean);
	const out: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		const lower = word.toLowerCase();
		// "gpt-5.1" reads as "GPT-5.1", not "GPT 5.1".
		if (lower === 'gpt' && i + 1 < words.length && /^\d/.test(words[i + 1])) {
			out.push(`GPT-${words[++i]}`);
			continue;
		}
		out.push(KNOWN_WORDS[lower] ?? capitalize(word));
	}
	return out.join(' ') || slug;
}

function capitalize(word: string): string {
	// Parameter sizes like "70b" read as "70B"; other words just get an initial capital.
	if (/^\d+(\.\d+)?b$/i.test(word)) {
		return word.toUpperCase();
	}
	return word.charAt(0).toUpperCase() + word.slice(1);
}
