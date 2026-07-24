import { describe, expect, it } from 'vitest';
import { slugifyModelId } from '../../src/modelSlug';

describe('slugifyModelId', () => {
	it('returns the id unchanged when there is no provider prefix', () => {
		expect(slugifyModelId('kimi-k3')).toBe('kimi-k3');
	});

	it('strips a single provider prefix', () => {
		expect(slugifyModelId('opencode-go/kimi-k3')).toBe('kimi-k3');
	});

	it('strips nested provider prefixes down to the last segment', () => {
		expect(slugifyModelId('openrouter/moonshotai/kimi-k3')).toBe('kimi-k3');
	});

	it('lowercases the result', () => {
		expect(slugifyModelId('openrouter/MoonshotAI/Kimi-K3')).toBe('kimi-k3');
	});

	it('cross-references the same model across different provider prefixes', () => {
		expect(slugifyModelId('openrouter/moonshotai/kimi-k3')).toBe(slugifyModelId('opencode-go/kimi-k3'));
	});

	it('treats an empty string as a single (empty) segment', () => {
		expect(slugifyModelId('')).toBe('');
	});

	it('treats a trailing slash as producing an empty final segment', () => {
		expect(slugifyModelId('provider/')).toBe('');
	});
});
