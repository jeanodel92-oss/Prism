// a `/settings` submenu as data. The terminal draws a page with its usual component
// (pageComponent); the Prism window draws the same page as native screens (settings-native.ts). The page holds
// the submenu's own callbacks, so both run the same code: the window rebuilds nothing from labels.
import {
	type Component,
	Container,
	type SelectItem,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";
import {
	SelectSubmenu,
	type SelectSubmenuOptions,
	SteppedSubmenu,
	type SteppedSubmenuStep,
} from "../modes/interactive/components/settings-submenu.ts";
import { theme } from "../modes/interactive/theme/theme.ts";
import { t } from "./i18n/index.ts";
import { ListEditor, type ListEditorOptions } from "./settings-list-editor.ts";
import { TextPage } from "./settings-text-page.ts";
import { ValueInput, type ValueInputOptions } from "./settings-value-input.ts";
import { settingsControlsTheme } from "./settings-view.ts";

export type SettingsPage =
	/** One value among `options`; `onSelect` and `onCancel` close it (or open the next page). */
	| {
			kind: "select";
			title: string;
			description: string;
			options: SelectItem[];
			current: string;
			onSelect(value: string): void | Promise<void>;
			onCancel(): void;
			onSelectionChange?(value: string): void;
			selectOptions?: SelectSubmenuOptions;
	  }
	/** Settings of their own, each changed through `onChange`. */
	| {
			kind: "rows";
			title: string;
			description: string;
			items: SettingItem[];
			onChange(id: string, value: string): void | Promise<void>;
			onClose(): void;
	  }
	| { kind: "text"; title: string; lines: string[]; done(): void }
	| { kind: "input"; input: ValueInputOptions }
	| { kind: "list"; list: ListEditorOptions }
	/** Values chosen one after the other; with `loop`, back to the first step after the last. */
	| {
			kind: "steps";
			steps: SteppedSubmenuStep[];
			onComplete(context: Record<string, string>): void;
			onCancel(): void;
			stepsOptions?: ConstructorParameters<typeof SteppedSubmenu>[3];
	  };

// Here rather than in settings-domains.ts: the pages of model-settings.ts would import the domains, which import
// the Prism editor through the animations, while the components' index is still loading (import cycle).
const MAX_VISIBLE_ROWS = 10;

/** A titled list of choices opened from a setting (web search); Escape returns to the domain. */
export class DomainSubmenu extends Container {
	private settingsList: SettingsList;

	constructor(
		title: string,
		description: string,
		items: SettingItem[],
		onChange: (id: string, value: string) => void | Promise<void>,
		onClose: () => void,
	) {
		super();
		this.addChild(new Text(theme.bold(theme.fg("accent", t(title))), 0, 0));
		this.addChild(new Text(theme.fg("muted", t(description)), 0, 0));
		this.settingsList = new SettingsList(
			items,
			Math.min(Math.max(items.length, 1), MAX_VISIBLE_ROWS),
			settingsControlsTheme(),
			onChange,
			onClose,
		);
		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

/** Builds a setting's page when it opens, with its current value; `done(value)` closes it, as a submenu's. */
export type SettingsPageFactory = (current: string, done: (value?: string) => void) => SettingsPage;

/** The terminal's component for a page. */
export function pageComponent(page: SettingsPage): Component {
	switch (page.kind) {
		case "select":
			return new SelectSubmenu(
				page.title,
				page.description,
				page.options,
				page.current,
				page.onSelect,
				page.onCancel,
				page.onSelectionChange,
				page.selectOptions,
			);
		case "rows":
			return new DomainSubmenu(page.title, page.description, page.items, page.onChange, page.onClose);
		case "text":
			return new TextPage(page.title, page.lines, page.done);
		case "input":
			return new ValueInput(page.input);
		case "list":
			return new ListEditor(page.list);
		case "steps":
			return new SteppedSubmenu(page.steps, page.onComplete, page.onCancel, page.stepsOptions);
	}
}

/**
 * A setting's submenu from its page: spread into the setting (`...paged(factory)`). The page stays on the item
 * for the window, which reads it with `pageOf`.
 */
export function paged(factory: SettingsPageFactory): Pick<SettingItem, "submenu"> {
	return Object.assign(
		{ submenu: (current: string, done: (value?: string) => void) => pageComponent(factory(current, done)) },
		{ page: factory },
	);
}

/** A page for the window next to a submenu the terminal keeps drawing with its own component (an upstream one). */
export function withPage(factory: SettingsPageFactory): object {
	return { page: factory };
}

export function pageOf(item: SettingItem): SettingsPageFactory | undefined {
	return (item as SettingItem & { page?: SettingsPageFactory }).page;
}
