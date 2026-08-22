import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { __setThinkingPartAvailable } from '../mocks/vscode';
import { createThinkingPart } from '../../src/thinking';

afterEach(() => {
	__setThinkingPartAvailable(true);
});

describe('createThinkingPart', () => {
	it('builds a real thinking part when the host exposes the API', () => {
		const part = createThinkingPart('reasoning');

		expect(part).toBeInstanceOf(vscode.LanguageModelThinkingPart!);
		expect((part as unknown as { value: string }).value).toBe('reasoning');
	});

	it('returns undefined on a host without the thinking part API', () => {
		__setThinkingPartAvailable(false);

		expect(createThinkingPart('reasoning')).toBeUndefined();
	});
});
