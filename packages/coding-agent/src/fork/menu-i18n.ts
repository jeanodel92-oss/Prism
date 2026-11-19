// fork: the menus of the bundled Goal and Plan plug-ins (pi-tui-kit screens) speak the
// harness's language. Their forks hand each menu definition to `translateMenu` before pi-tui-kit draws it (published
// on globalThis by vendored.ts): the texts it shows go through t(); ids, and the values a plug-in reads back, do not.
import { t } from "./i18n/index.ts";

export const MENU_I18N = Symbol.for("prism.translateMenu");
export const UI_I18N = Symbol.for("prism.translateUi");
export const KIT_I18N = Symbol.for("prism.translateKitText");

interface Item {
	id: string;
	label?: string;
	description?: string;
	disabledReason?: string;
	busyLabel?: string;
	statusText?: string;
	details?: readonly string[];
	currentValue?: string;
	values?: readonly string[];
}

interface Screen {
	kind: string;
	title: string;
	lines?: readonly string[];
	items?: readonly Item[];
	actions?: readonly Item[];
	placeholder?: string;
	doneLabel?: string;
	confirm?: { label: string };
}

interface ActionContext {
	itemId: string;
	value?: string;
}

interface MenuDefinition {
	screens: Record<string, (context: unknown) => Screen>;
	actions: Record<string, (context: ActionContext) => unknown>;
}

const lines = (value: readonly string[] | undefined) => value?.map(t);
/** A message line by line: its lines are the entries, and some carry the user's own text. */
const message = (value: string) => value.split("\n").map(t).join("\n");

interface DialogUi {
	notify(message: string, level?: unknown): void;
	confirm(title: string, message: string, options?: unknown): Promise<boolean>;
	editor(title: string, prefill?: string, options?: unknown): Promise<string | undefined>;
	input(title: string, placeholder?: string, options?: unknown): Promise<string | undefined>;
}

/** Visible plug-in text, or its dialogs and notifications; a prefilled text stays the user's. */
export function translateUi(text: string): string;
export function translateUi(ui: DialogUi): DialogUi;
export function translateUi(ui: DialogUi | string): DialogUi | string {
	if (typeof ui === "string") return message(ui);
	return {
		notify: (text, level) => ui.notify(message(text), level),
		confirm: (title, text, options) => ui.confirm(message(title), message(text), options),
		editor: (title, prefill, options) => ui.editor(message(title), prefill, options),
		input: (title, placeholder, options) =>
			ui.input(message(title), placeholder === undefined ? undefined : t(placeholder), options),
	};
}

/** The menu with its shown texts in the active language. */
export function translateMenu<Menu extends MenuDefinition>(menu: Menu): Menu {
	// A setting's shown value, by item, back to the plug-in's own value.
	const settingValues = new Map<string, Map<string, string>>();
	const item = (source: Item): Item => {
		const out: Item = { ...source };
		if (source.label !== undefined) out.label = t(source.label);
		if (source.description !== undefined) out.description = t(source.description);
		if (source.disabledReason !== undefined) out.disabledReason = t(source.disabledReason);
		if (source.busyLabel !== undefined) out.busyLabel = t(source.busyLabel);
		if (source.statusText !== undefined) out.statusText = t(source.statusText);
		if (source.details !== undefined) out.details = lines(source.details);
		if (source.currentValue !== undefined) {
			const shown = new Map<string, string>();
			for (const value of [source.currentValue, ...(source.values ?? [])]) shown.set(t(value), value);
			settingValues.set(source.id, shown);
			out.currentValue = t(source.currentValue);
			if (source.values !== undefined) out.values = source.values.map(t);
		}
		return out;
	};
	const screen = (source: Screen): Screen => {
		const out: Screen = { ...source, title: t(source.title) };
		if (source.lines !== undefined) out.lines = lines(source.lines);
		if (source.items !== undefined) out.items = source.items.map(item);
		if (source.actions !== undefined) out.actions = source.actions.map(item);
		if (source.placeholder !== undefined) out.placeholder = t(source.placeholder);
		if (source.doneLabel !== undefined) out.doneLabel = t(source.doneLabel);
		if (source.confirm !== undefined) out.confirm = { ...source.confirm, label: t(source.confirm.label) };
		return out;
	};
	const screens = Object.fromEntries(
		Object.entries(menu.screens).map(([id, factory]) => [id, (context: unknown) => screen(factory(context))]),
	);
	const actions = Object.fromEntries(
		Object.entries(menu.actions).map(([id, handler]) => [
			id,
			(context: ActionContext) => {
				const original =
					context.value === undefined ? undefined : settingValues.get(context.itemId)?.get(context.value);
				return handler(original === undefined ? context : { ...context, value: original });
			},
		]),
	);
	return { ...menu, screens, actions };
}

// pi-tui-kit's own texts, as it styles them: whole, or a fixed part around a value it adds (a setting's value, a
// reason the menu already translated). Nothing else is touched, so a tool name or a value never matches a pattern.
const KIT_TEXTS = new Set([
	// Chrome's cancellable loader and disabled multi-select rows.
	" cancel",
	"Unavailable",
	"Type to search",
	"  No items available",
	"  No matching items",
	"  No choices available",
	"  No matching choices",
	"  No settings available",
	"  No matching settings",
	"  Unavailable",
]);
const KIT_PREFIXES = ["(unavailable) ", "  Unavailable: ", "Unavailable: ", "unavailable: "];
const KIT_SUFFIXES = [" ✓ current", " (unavailable)"];

// the navigation choices pi-tui-kit adds to the menus it asks
// as dialogs (RPC clients), in English; the kit is not patched. Shown translated, answered with the kit's own text.
const KIT_CHOICES = new Set(["Back", "← Back", "Done", "Previous", "Next", "Close"]);

/** A dialog's choices in the interface's language, and how to give back the one chosen as the asker wrote it. */
export function translateKitChoices(options: readonly string[]): {
	shown: string[];
	original: (value: string) => string;
} {
	const translated = options.map((option) => (KIT_CHOICES.has(option) ? t(option) : option));
	// fork: a translation that reads like another choice ("Back" shown as "Retour"
	// next to an extension's own "Retour") keeps its own text, so each shown choice names one option.
	const shown = translated.map((text, index) =>
		text !== options[index] && translated.indexOf(text) !== translated.lastIndexOf(text) ? options[index] : text,
	);
	return { shown, original: (value) => options[shown.indexOf(value)] ?? value };
}

/** A text pi-tui-kit draws through the theme, translated when it is one of the kit's own; else as it is. */
export function translateKitText(text: string): string {
	if (KIT_TEXTS.has(text)) return t(text);
	const prefix = KIT_PREFIXES.find((fixed) => text.startsWith(fixed));
	if (prefix) return t(prefix) + text.slice(prefix.length);
	const suffix = KIT_SUFFIXES.find((fixed) => text.endsWith(fixed));
	if (suffix) return text.slice(0, -suffix.length) + t(suffix);
	return text;
}
