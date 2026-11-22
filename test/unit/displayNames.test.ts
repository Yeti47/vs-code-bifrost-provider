import { describe, expect, it } from 'vitest';
import { formatModelName, formatProviderName } from '../../src/displayNames';

describe('formatProviderName', () => {
	it.each([
		['github-copilot', 'GitHub Copilot'],
		['opencode-go', 'OpenCode Go'],
		['openrouter', 'OpenRouter'],
		['openai', 'OpenAI'],
		['anthropic', 'Anthropic'],
		['ollama', 'Ollama'],
		['xai', 'xAI']
	])('formats %s as %s', (provider, expected) => {
		expect(formatProviderName(provider)).toBe(expected);
	});
});

describe('formatModelName', () => {
	it.each([
		['github-copilot/claude-sonnet-5.5', 'Claude Sonnet 5.5'],
		['opencode-go/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'],
		['openai/gpt-5.1-codex-mini', 'GPT-5.1 Codex Mini'],
		['openai/gpt-4o', 'GPT-4o'],
		['openrouter/moonshotai/kimi-k3', 'Kimi K3'],
		['ollama/qwen3-coder-30b', 'Qwen3 Coder 30B'],
		['plain-model', 'Plain Model']
	])('derives a name for %s', (id, expected) => {
		expect(formatModelName(id, undefined)).toBe(expected);
	});

	it('uses the name Bifrost reports when it is a real display name', () => {
		expect(formatModelName('anthropic/claude-opus-5-5', 'Claude Opus 5.5')).toBe('Claude Opus 5.5');
	});

	it('ignores a reported name that just repeats the id', () => {
		expect(formatModelName('github-copilot/claude-opus-5.5', 'github-copilot/claude-opus-5.5')).toBe('Claude Opus 5.5');
		expect(formatModelName('github-copilot/claude-opus-5.5', 'claude-opus-5.5')).toBe('Claude Opus 5.5');
	});

	it('ignores a blank reported name', () => {
		expect(formatModelName('custom/my-model', '  ')).toBe('My Model');
	});
});
