/**
 * Minimal in-memory stand-in for the `vscode` module, used only by unit tests (aliased in
 * vitest.config.ts). Implements just enough of the real API surface for the extension's own
 * source files to run against; it is not a faithful reimplementation of VS Code.
 */
import { vi } from 'vitest';

export class Disposable {
	constructor(private readonly callOnDispose?: () => void) { }
	dispose(): void {
		this.callOnDispose?.();
	}
}

export class EventEmitter<T> {
	private listeners: Array<(e: T) => void> = [];

	event = (listener: (e: T) => void): Disposable => {
		this.listeners.push(listener);
		return new Disposable(() => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		});
	};

	fire(data: T): void {
		for (const listener of [...this.listeners]) {
			listener(data);
		}
	}

	dispose(): void {
		this.listeners = [];
	}
}

export interface CancellationToken {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: (e: unknown) => void): Disposable;
}

export class CancellationTokenSource {
	private cancelled = false;
	private readonly emitter = new EventEmitter<unknown>();
	readonly token: CancellationToken;

	constructor() {
		const self = this;
		this.token = {
			get isCancellationRequested() {
				return self.cancelled;
			},
			onCancellationRequested: (listener: (e: unknown) => void) => self.emitter.event(listener)
		};
	}

	cancel(): void {
		if (this.cancelled) {
			return;
		}
		this.cancelled = true;
		this.emitter.fire(undefined);
	}

	dispose(): void {
		this.emitter.dispose();
	}
}

export enum LanguageModelChatMessageRole {
	User = 1,
	Assistant = 2
}

export enum LanguageModelChatToolMode {
	Auto = 1,
	Required = 2
}

export enum ConfigurationTarget {
	Global = 1,
	Workspace = 2,
	WorkspaceFolder = 3
}

export class LanguageModelTextPart {
	constructor(public value: string) { }
}

export class LanguageModelToolCallPart {
	constructor(public callId: string, public name: string, public input: object) { }
}

export class LanguageModelToolResultPart {
	constructor(public callId: string, public content: readonly unknown[]) { }
}

export class LanguageModelDataPart {
	constructor(public data: Uint8Array, public mimeType: string) { }
}

// Named class expression: the binding is `...Impl`, but `.name` is `LanguageModelThinkingPart`, which
// is what the real host class reports and what `src/thinking.ts` falls back to matching on.
const LanguageModelThinkingPartImpl = class LanguageModelThinkingPart {
	constructor(
		public value: string | string[],
		public id?: string,
		public metadata?: { readonly [key: string]: unknown }
	) { }
};

/**
 * Exported via `let` so tests can simulate a host without the (still proposed) thinking part API —
 * ES module live bindings make the change visible through the `import * as vscode` namespace that
 * `src/thinking.ts` reads. See `__setThinkingPartAvailable`.
 */
export let LanguageModelThinkingPart: typeof LanguageModelThinkingPartImpl | undefined =
	LanguageModelThinkingPartImpl;

export function __setThinkingPartAvailable(available: boolean): void {
	LanguageModelThinkingPart = available ? LanguageModelThinkingPartImpl : undefined;
}

/** Builds a thinking part regardless of whether the API is currently "available" to the extension. */
export function __makeThinkingPart(
	value: string | string[],
	id?: string
): InstanceType<typeof LanguageModelThinkingPartImpl> {
	return new LanguageModelThinkingPartImpl(value, id);
}

export class Uri {
	private constructor(public readonly fsPath: string) { }
	static file(path: string): Uri {
		return new Uri(path);
	}
	static joinPath(base: Uri, ...segments: string[]): Uri {
		return new Uri([base.fsPath, ...segments].join('/'));
	}
	toString(): string {
		return this.fsPath;
	}
}

interface ConfigurationStore {
	get<T>(key: string, defaultValue?: T): T | undefined;
	update(key: string, value: unknown): Promise<void>;
}

const configValues = new Map<string, unknown>();

function makeConfiguration(section: string): ConfigurationStore {
	return {
		get<T>(key: string, defaultValue?: T): T | undefined {
			const fullKey = `${section}.${key}`;
			return configValues.has(fullKey) ? (configValues.get(fullKey) as T) : defaultValue;
		},
		update(key: string, value: unknown): Promise<void> {
			configValues.set(`${section}.${key}`, value);
			return Promise.resolve();
		}
	};
}

const fsFiles = new Map<string, Uint8Array>();
const configChangeEmitter = new EventEmitter<{ affectsConfiguration: (section: string) => boolean }>();

export const workspace = {
	getConfiguration: (section: string) => makeConfiguration(section),
	onDidChangeConfiguration: (listener: (e: { affectsConfiguration: (section: string) => boolean }) => void) =>
		configChangeEmitter.event(listener),
	fs: {
		readFile: async (uri: Uri): Promise<Uint8Array> => {
			const data = fsFiles.get(uri.toString());
			if (!data) {
				throw new Error(`ENOENT: ${uri.toString()}`);
			}
			return data;
		},
		writeFile: async (uri: Uri, content: Uint8Array): Promise<void> => {
			fsFiles.set(uri.toString(), content);
		},
		createDirectory: async (): Promise<void> => { }
	}
};

/** Lines written to every output channel created during a test, newest last. */
export const __outputChannelLines: string[] = [];

export const window = {
	showInputBox: vi.fn(),
	showInformationMessage: vi.fn(),
	showErrorMessage: vi.fn(),
	createOutputChannel: vi.fn((_name: string) => ({
		appendLine: (line: string) => {
			__outputChannelLines.push(line);
		},
		dispose: () => { }
	}))
};

export const commands = {
	registerCommand: vi.fn((_id: string, _handler: (...args: unknown[]) => unknown) => new Disposable()),
	executeCommand: vi.fn()
};

export const lm = {
	registerLanguageModelChatProvider: vi.fn(() => new Disposable())
};

/** Test-only helpers for controlling/resetting the mock's shared in-memory state. */
export function __setConfigValue(section: string, key: string, value: unknown): void {
	configValues.set(`${section}.${key}`, value);
}

export function __fireConfigurationChange(affectedSection: string): void {
	configChangeEmitter.fire({ affectsConfiguration: (section) => section === affectedSection });
}

export function __resetMockVscodeState(): void {
	configValues.clear();
	fsFiles.clear();
	__setThinkingPartAvailable(true);
	__outputChannelLines.length = 0;
	window.showInputBox.mockReset();
	window.showInformationMessage.mockReset();
	window.showErrorMessage.mockReset();
	window.createOutputChannel.mockClear();
	commands.registerCommand.mockClear();
	commands.executeCommand.mockReset();
	lm.registerLanguageModelChatProvider.mockClear();
}
