import * as vscode from 'vscode';
import { ProfileStore, validateProfileName } from './profiles';

export const SELECT_PROFILE_COMMAND = 'bifrost.selectProfile';
export const CONFIGURE_PROFILES_COMMAND = 'bifrost.configureProfiles';

/** Status bar entry + commands for picking and managing profiles. */
export function registerProfileUi(store: ProfileStore): vscode.Disposable {
	const statusBarItem = vscode.window.createStatusBarItem('bifrost.profile', vscode.StatusBarAlignment.Right, 100);
	statusBarItem.name = 'Bifrost Profile';
	statusBarItem.command = SELECT_PROFILE_COMMAND;

	const refresh = (): void => {
		const active = store.getActiveProfile();
		statusBarItem.text = `$(tag) ${active ?? 'No profile'}`;
		statusBarItem.tooltip = active
			? `Bifrost profile "${active}" — sent as the x-bf-profile header. Click to change.`
			: 'No Bifrost profile selected. Click to select one.';
	};
	refresh();
	statusBarItem.show();

	return vscode.Disposable.from(
		statusBarItem,
		store.onDidChange(refresh),
		vscode.commands.registerCommand(SELECT_PROFILE_COMMAND, () => selectProfile(store)),
		vscode.commands.registerCommand(CONFIGURE_PROFILES_COMMAND, () => configureProfiles(store))
	);
}

type SelectItem = vscode.QuickPickItem & { action?: 'none' | 'configure'; profile?: string };

async function selectProfile(store: ProfileStore): Promise<void> {
	const active = store.getActiveProfile();
	const items: SelectItem[] = [
		{
			label: '$(circle-slash) No profile',
			description: active === undefined ? 'current' : undefined,
			detail: 'Don\'t send an x-bf-profile header',
			action: 'none'
		},
		...store.getProfiles().map<SelectItem>((profile) => ({
			label: `$(tag) ${profile}`,
			description: profile === active ? 'current' : undefined,
			profile
		})),
		{ label: '', kind: vscode.QuickPickItemKind.Separator },
		{ label: '$(gear) Configure Profiles…', action: 'configure' }
	];

	const picked = await pickOne(items, {
		title: 'Bifrost Profile',
		placeholder: 'Select the profile to send with Bifrost requests',
		activeItem: items.find((item) => (active === undefined ? item.action === 'none' : item.profile === active))
	});
	if (!picked) {
		return;
	}
	if (picked.action === 'configure') {
		await configureProfiles(store);
	} else {
		await store.setActiveProfile(picked.profile);
	}
}

const RENAME_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Rename' };
const REMOVE_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remove' };

type ConfigureItem = vscode.QuickPickItem & { profile?: string };
type ConfigureAction =
	| { kind: 'add' }
	| { kind: 'manage'; profile: string }
	| { kind: 'rename'; profile: string }
	| { kind: 'remove'; profile: string };

/** Loops so the list re-renders with fresh contents after every add/rename/remove. */
async function configureProfiles(store: ProfileStore): Promise<void> {
	while (true) {
		const action = await pickConfigureAction(store);
		if (!action) {
			return;
		}
		try {
			switch (action.kind) {
				case 'add': {
					const name = await promptProfileName(store.getProfiles());
					if (name !== undefined) {
						await store.addProfile(name);
					}
					break;
				}
				case 'rename':
					await renameProfile(store, action.profile);
					break;
				case 'remove':
					await store.removeProfile(action.profile);
					break;
				case 'manage':
					await manageProfile(store, action.profile);
					break;
			}
		} catch (err) {
			vscode.window.showErrorMessage(`Could not update Bifrost profiles: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

function pickConfigureAction(store: ProfileStore): Promise<ConfigureAction | undefined> {
	const active = store.getActiveProfile();
	const items: ConfigureItem[] = [
		{ label: '$(add) Add Profile…', alwaysShow: true },
		...store.getProfiles().map<ConfigureItem>((profile) => ({
			label: `$(tag) ${profile}`,
			description: profile === active ? 'current' : undefined,
			buttons: [RENAME_BUTTON, REMOVE_BUTTON],
			profile
		}))
	];

	return new Promise((resolve) => {
		const quickPick = vscode.window.createQuickPick<ConfigureItem>();
		quickPick.title = 'Configure Bifrost Profiles';
		quickPick.placeholder = items.length > 1
			? 'Add a profile, or pick one to use, rename or remove it'
			: 'No profiles yet — add one to tag requests with an x-bf-profile header';
		quickPick.items = items;

		let result: ConfigureAction | undefined;
		quickPick.onDidAccept(() => {
			const [item] = quickPick.selectedItems;
			result = item?.profile !== undefined ? { kind: 'manage', profile: item.profile } : item ? { kind: 'add' } : undefined;
			quickPick.hide();
		});
		quickPick.onDidTriggerItemButton((e) => {
			if (e.item.profile !== undefined) {
				result = { kind: e.button === REMOVE_BUTTON ? 'remove' : 'rename', profile: e.item.profile };
				quickPick.hide();
			}
		});
		quickPick.onDidHide(() => {
			quickPick.dispose();
			resolve(result);
		});
		quickPick.show();
	});
}

async function manageProfile(store: ProfileStore, profile: string): Promise<void> {
	type ManageItem = vscode.QuickPickItem & { run: () => Promise<void> };
	const isActive = store.getActiveProfile() === profile;
	const items: ManageItem[] = [
		isActive
			? { label: '$(circle-slash) Stop Using This Profile', run: () => store.setActiveProfile(undefined) }
			: { label: '$(check) Use This Profile', run: () => store.setActiveProfile(profile) },
		{ label: '$(edit) Rename…', run: () => renameProfile(store, profile) },
		{ label: '$(trash) Remove', run: () => store.removeProfile(profile) }
	];
	const picked = await pickOne(items, { title: `Bifrost Profile: ${profile}` });
	await picked?.run();
}

async function renameProfile(store: ProfileStore, profile: string): Promise<void> {
	const newName = await promptProfileName(
		store.getProfiles().filter((p) => p !== profile),
		profile
	);
	if (newName !== undefined) {
		await store.renameProfile(profile, newName);
	}
}

async function promptProfileName(existing: readonly string[], current?: string): Promise<string | undefined> {
	return vscode.window.showInputBox({
		title: current === undefined ? 'Add Bifrost Profile' : `Rename Bifrost Profile "${current}"`,
		prompt: 'Sent verbatim as the x-bf-profile header — match it in your Bifrost routing rules.',
		placeHolder: 'e.g. my-project',
		value: current,
		ignoreFocusOut: true,
		validateInput: (value) => validateProfileName(value, existing)
	});
}

/** Like showQuickPick, but can preselect an item (showQuickPick always highlights the first). */
function pickOne<T extends vscode.QuickPickItem>(
	items: readonly T[],
	options: { title: string; placeholder?: string; activeItem?: T }
): Promise<T | undefined> {
	return new Promise((resolve) => {
		const quickPick = vscode.window.createQuickPick<T>();
		quickPick.title = options.title;
		quickPick.placeholder = options.placeholder;
		quickPick.items = items;
		if (options.activeItem) {
			quickPick.activeItems = [options.activeItem];
		}

		let result: T | undefined;
		quickPick.onDidAccept(() => {
			result = quickPick.selectedItems[0];
			quickPick.hide();
		});
		quickPick.onDidHide(() => {
			quickPick.dispose();
			resolve(result);
		});
		quickPick.show();
	});
}
