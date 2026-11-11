import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { __fireConfigurationChange, __resetMockVscodeState, __setConfigValue } from '../mocks/vscode';
import { ProfileStore, validateProfileName } from '../../src/profiles';

function storedProfiles(): unknown {
	return vscode.workspace.getConfiguration('bifrost').get('profiles');
}

describe('validateProfileName', () => {
	it('accepts printable ASCII names, including inner spaces', () => {
		expect(validateProfileName('my-project', [])).toBeUndefined();
		expect(validateProfileName('Client A / backend', [])).toBeUndefined();
	});

	it('rejects empty and whitespace-only names', () => {
		expect(validateProfileName('', [])).toMatch(/required/);
		expect(validateProfileName('   ', [])).toMatch(/required/);
	});

	it('rejects leading/trailing whitespace', () => {
		expect(validateProfileName(' a', [])).toMatch(/whitespace/);
		expect(validateProfileName('a ', [])).toMatch(/whitespace/);
	});

	it('rejects characters that are not valid in a header value', () => {
		expect(validateProfileName('a\nb', [])).toMatch(/printable ASCII/);
		expect(validateProfileName('projekt-ü', [])).toMatch(/printable ASCII/);
	});

	it('rejects overly long names', () => {
		expect(validateProfileName('a'.repeat(129), [])).toMatch(/at most 128/);
		expect(validateProfileName('a'.repeat(128), [])).toBeUndefined();
	});

	it('rejects duplicates', () => {
		expect(validateProfileName('a', ['a'])).toMatch(/already exists/);
	});
});

describe('ProfileStore', () => {
	beforeEach(() => {
		__resetMockVscodeState();
	});

	it('starts with no profiles and no active profile', () => {
		const store = new ProfileStore();
		expect(store.getProfiles()).toEqual([]);
		expect(store.getActiveProfile()).toBeUndefined();
	});

	it('drops invalid and duplicate entries from hand-edited settings', () => {
		__setConfigValue('bifrost', 'profiles', ['ok', 'ok', ' padded', 42, 'bad\nname', 'also-ok']);
		const store = new ProfileStore();
		expect(store.getProfiles()).toEqual(['ok', 'also-ok']);
	});

	it('treats a non-array setting as empty', () => {
		__setConfigValue('bifrost', 'profiles', 'not-an-array');
		expect(new ProfileStore().getProfiles()).toEqual([]);
	});

	it('adds profiles and persists them to settings', async () => {
		const store = new ProfileStore();
		await store.addProfile('a');
		await store.addProfile('b');
		expect(storedProfiles()).toEqual(['a', 'b']);
	});

	it('refuses to add an invalid or duplicate profile', async () => {
		const store = new ProfileStore();
		await store.addProfile('a');
		await expect(store.addProfile('a')).rejects.toThrow(/already exists/);
		await expect(store.addProfile('')).rejects.toThrow(/required/);
		expect(storedProfiles()).toEqual(['a']);
	});

	it('selects and clears the active profile via the global setting', async () => {
		const store = new ProfileStore();
		await store.addProfile('a');
		await store.setActiveProfile('a');
		expect(store.getActiveProfile()).toBe('a');
		expect(vscode.workspace.getConfiguration('bifrost').get('activeProfile')).toBe('a');
		await store.setActiveProfile(undefined);
		expect(store.getActiveProfile()).toBeUndefined();
	});

	it('shares the selection across stores, as every window reads the same setting', async () => {
		const windowA = new ProfileStore();
		const windowB = new ProfileStore();
		await windowA.addProfile('a');
		await windowA.setActiveProfile('a');
		expect(windowB.getActiveProfile()).toBe('a');
	});

	it('treats an empty or non-string activeProfile setting as no profile', () => {
		__setConfigValue('bifrost', 'profiles', ['a']);
		__setConfigValue('bifrost', 'activeProfile', '');
		expect(new ProfileStore().getActiveProfile()).toBeUndefined();
		__setConfigValue('bifrost', 'activeProfile', 42);
		expect(new ProfileStore().getActiveProfile()).toBeUndefined();
	});

	it('ignores a stored selection that no longer exists in the profile list', async () => {
		const store = new ProfileStore();
		await store.addProfile('a');
		await store.setActiveProfile('a');
		__setConfigValue('bifrost', 'profiles', ['b']);
		expect(store.getActiveProfile()).toBeUndefined();
	});

	it('keeps the selection on the renamed profile', async () => {
		const store = new ProfileStore();
		await store.addProfile('a');
		await store.addProfile('b');
		await store.setActiveProfile('a');
		await store.renameProfile('a', 'c');
		expect(storedProfiles()).toEqual(['c', 'b']);
		expect(store.getActiveProfile()).toBe('c');
	});

	it('does not move the selection when renaming a different profile', async () => {
		const store = new ProfileStore();
		await store.addProfile('a');
		await store.addProfile('b');
		await store.setActiveProfile('a');
		await store.renameProfile('b', 'c');
		expect(store.getActiveProfile()).toBe('a');
	});

	it('refuses to rename onto an existing profile', async () => {
		const store = new ProfileStore();
		await store.addProfile('a');
		await store.addProfile('b');
		await expect(store.renameProfile('a', 'b')).rejects.toThrow(/already exists/);
		expect(storedProfiles()).toEqual(['a', 'b']);
	});

	it('clears the selection when the active profile is removed', async () => {
		const store = new ProfileStore();
		await store.addProfile('a');
		await store.setActiveProfile('a');
		await store.removeProfile('a');
		expect(storedProfiles()).toEqual([]);
		expect(store.getActiveProfile()).toBeUndefined();
		// Re-adding a removed profile must not silently re-activate it.
		await store.addProfile('a');
		expect(store.getActiveProfile()).toBeUndefined();
	});

	it('fires onDidChange for selection, list edits, and settings changed elsewhere (e.g. another window)', async () => {
		const store = new ProfileStore();
		const listener = vi.fn();
		store.onDidChange(listener);

		await store.addProfile('a');
		await store.setActiveProfile('a');
		__fireConfigurationChange('bifrost.profiles');
		__fireConfigurationChange('bifrost.activeProfile');
		__fireConfigurationChange('bifrost.baseUrl');

		expect(listener).toHaveBeenCalledTimes(4);
	});
});
