import * as vscode from 'vscode';

const CONFIG_SECTION = 'bifrost';
const PROFILES_KEY = 'profiles';
const ACTIVE_PROFILE_KEY = 'activeProfile';

/** Read side of the profile store — all the chat provider needs. */
export interface ActiveProfileSource {
	getActiveProfile(): string | undefined;
}

/**
 * Profiles are plain names sent as the `x-bf-profile` header so Bifrost routing rules and log
 * filters can tell requests apart (e.g. one profile per project on a shared virtual key).
 *
 * Both the list (`bifrost.profiles`) and the selection (`bifrost.activeProfile`) are global user
 * settings. The selection is deliberately not per-workspace: the Copilot harness is one shared
 * process that gets Bifrost responses from a single window's extension host, and requests carry no
 * workspace, so a per-window choice would silently tag sessions with another window's profile.
 * A setting also notifies every window on change, keeping all status bars in sync.
 */
export class ProfileStore implements ActiveProfileSource, vscode.Disposable {
	private readonly didChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.didChangeEmitter.event;
	private readonly configListener: vscode.Disposable;

	constructor() {
		this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
			if (
				e.affectsConfiguration(`${CONFIG_SECTION}.${PROFILES_KEY}`) ||
				e.affectsConfiguration(`${CONFIG_SECTION}.${ACTIVE_PROFILE_KEY}`)
			) {
				this.didChangeEmitter.fire();
			}
		});
	}

	dispose(): void {
		this.configListener.dispose();
		this.didChangeEmitter.dispose();
	}

	getProfiles(): string[] {
		const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>(PROFILES_KEY, []);
		if (!Array.isArray(raw)) {
			return [];
		}
		// Hand-edited settings may contain junk; only names that are valid header values are usable.
		const seen = new Set<string>();
		const profiles: string[] = [];
		for (const entry of raw) {
			if (typeof entry === 'string' && isValidProfileName(entry) && !seen.has(entry)) {
				seen.add(entry);
				profiles.push(entry);
			}
		}
		return profiles;
	}

	/** The selected profile, or undefined if none is selected or it no longer exists. */
	getActiveProfile(): string | undefined {
		const active = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>(ACTIVE_PROFILE_KEY);
		return typeof active === 'string' && this.getProfiles().includes(active) ? active : undefined;
	}

	async setActiveProfile(name: string | undefined): Promise<void> {
		// undefined removes the key from settings.json rather than leaving an empty string behind.
		await vscode.workspace
			.getConfiguration(CONFIG_SECTION)
			.update(ACTIVE_PROFILE_KEY, name, vscode.ConfigurationTarget.Global);
		this.didChangeEmitter.fire();
	}

	async addProfile(name: string): Promise<void> {
		const error = validateProfileName(name, this.getProfiles());
		if (error) {
			throw new Error(error);
		}
		await this.saveProfiles([...this.getProfiles(), name]);
	}

	async renameProfile(oldName: string, newName: string): Promise<void> {
		if (oldName === newName) {
			return;
		}
		const profiles = this.getProfiles();
		const error = validateProfileName(newName, profiles.filter((p) => p !== oldName));
		if (error) {
			throw new Error(error);
		}
		const wasActive = this.getActiveProfile() === oldName;
		await this.saveProfiles(profiles.map((p) => (p === oldName ? newName : p)));
		if (wasActive) {
			await this.setActiveProfile(newName);
		}
	}

	async removeProfile(name: string): Promise<void> {
		const wasActive = this.getActiveProfile() === name;
		await this.saveProfiles(this.getProfiles().filter((p) => p !== name));
		if (wasActive) {
			await this.setActiveProfile(undefined);
		}
	}

	private async saveProfiles(profiles: string[]): Promise<void> {
		await vscode.workspace
			.getConfiguration(CONFIG_SECTION)
			.update(PROFILES_KEY, profiles, vscode.ConfigurationTarget.Global);
		// The config listener also fires in VS Code; firing here keeps callers' views consistent
		// immediately after the await, regardless of event ordering.
		this.didChangeEmitter.fire();
	}
}

const MAX_PROFILE_NAME_LENGTH = 128;
// Printable ASCII only: HTTP header values outside this range are either rejected by fetch or
// mangled by proxies, and Bifrost routing rules compare the value verbatim.
const PROFILE_NAME_PATTERN = /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/;

function isValidProfileName(name: string): boolean {
	return name.length <= MAX_PROFILE_NAME_LENGTH && PROFILE_NAME_PATTERN.test(name);
}

/** Returns an error message for an invalid new profile name, or undefined if it is acceptable. */
export function validateProfileName(name: string, existing: readonly string[]): string | undefined {
	if (!name.trim()) {
		return 'A profile name is required.';
	}
	if (name !== name.trim()) {
		return 'Profile names cannot start or end with whitespace.';
	}
	if (name.length > MAX_PROFILE_NAME_LENGTH) {
		return `Profile names can be at most ${MAX_PROFILE_NAME_LENGTH} characters.`;
	}
	if (!PROFILE_NAME_PATTERN.test(name)) {
		return 'Profile names can only contain printable ASCII characters (they are sent as an HTTP header).';
	}
	if (existing.includes(name)) {
		return `A profile named "${name}" already exists.`;
	}
	return undefined;
}
