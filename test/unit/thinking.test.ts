import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { __makeThinkingPart, __setThinkingPartAvailable } from '../mocks/vscode';
import { createThinkingPart, isThinkingPart, thinkingPartText } from '../../src/thinking';

afterEach(() => {
	__setThinkingPartAvailable(true);
});

describe('createThinkingPart', () => {
	it('builds a real thinking part when the host exposes the API', () => {
		const part = createThinkingPart('reasoning', 'id-1');

		expect(part).toBeDefined();
		expect(part?.constructor).toBe(__makeThinkingPart('').constructor);
		expect(isThinkingPart(part)).toBe(true);
		expect(thinkingPartText(part as never)).toBe('reasoning');
		expect((part as unknown as { id?: string }).id).toBe('id-1');
	});

	it('returns undefined on a host without the thinking part API', () => {
		__setThinkingPartAvailable(false);

		expect(createThinkingPart('reasoning')).toBeUndefined();
	});
});

describe('isThinkingPart', () => {
	it('recognises thinking parts even when the class is not exposed on the namespace', () => {
		const part = __makeThinkingPart('reasoning');
		__setThinkingPartAvailable(false);

		expect(isThinkingPart(part)).toBe(true);
	});

	it('does not mistake a text part for a thinking part', () => {
		expect(isThinkingPart(new vscode.LanguageModelTextPart('hello'))).toBe(false);
	});

	it('rejects non-parts', () => {
		expect(isThinkingPart(undefined)).toBe(false);
		expect(isThinkingPart(null)).toBe(false);
		expect(isThinkingPart('reasoning')).toBe(false);
		expect(isThinkingPart({ value: 'reasoning' })).toBe(false);
	});
});

describe('thinkingPartText', () => {
	it('passes a string value through', () => {
		expect(thinkingPartText({ value: 'reasoning' })).toBe('reasoning');
	});

	it('joins a fragmented value', () => {
		expect(thinkingPartText({ value: ['think', 'ing'] })).toBe('thinking');
	});

	it('tolerates a missing value', () => {
		expect(thinkingPartText({ value: undefined as never })).toBe('');
	});
});
