// `/settings` as native screens of the Prism window: the domains, a domain's settings, then the
// page a setting opens. The settings, their grouping and their change handler are the terminal's
// (settings-operations.ts, settings-domains.ts); a submenu is drawn from its page (settings-pages.ts). Nothing here
// saves a setting: every change goes through the model's `onChange` or the page's own callbacks, as in the terminal.
import type { SelectItem, SettingItem } from "@earendil-works/pi-tui";
import type { AgentSession } from "../core/agent-session.ts";
import type { ExtensionContext } from "../core/extensions/types.ts";
import { settingsItems } from "../modes/interactive/components/settings-selector.ts";
import { SYSTEM_THEME_NAME } from "../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../utils/ansi.ts";
import { t } from "./i18n/index.ts";
import { type NativeAction, NativeFlow, type NativeScreen, showNativeFlow } from "./native-flow.ts";
import { groupSettingsByDomain, type SettingsModel } from "./settings-domains.ts";
import type { ListStep } from "./settings-list-editor.ts";
import { settingsOperations } from "./settings-operations.ts";
import { pageOf, type SettingsPage, type SettingsPageFactory } from "./settings-pages.ts";

/** One screen of the stack, drawn again at each change; `undefined` when what it showed is gone. */
type Frame = (
	prefix: string,
) => { screen: NativeScreen; handle(action: NativeAction): boolean | Promise<boolean> } | undefined;

export interface NativeSettingsOptions {
	model: SettingsModel;
	/** The domain to open, and the setting to open in it. */
	start?: { domain?: string; item?: string; open?: boolean };
	/**
	 * "sections": the window's Settings dialog lists the domains beside the screen, so every screen carries them
	 * (`sections`, `section`) and takes `{kind: "section", sectionId}` from any depth; there is no domains screen.
	 */
	layout?: "sections";
	/** Settings closed, by Close, with the panel, or by `stop`. */
	onClose(): void;
}

/** A row's kind, as the terminal's SettingsView reads it. */
const rowKind = (item: SettingItem) =>
	item.submenu
		? "page"
		: !item.values || item.values.length === 0
			? "info"
			: item.values.length === 1
				? "action"
				: "choice";

const plain = (text: string | undefined) => (text === undefined ? undefined : stripAnsi(text));

/** Text as the terminal's settings search compares it: without colours, accents or case (settings-view.ts). */
const fold = (text: string) => stripAnsi(text).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The identifier an action names without the screen's prefix, or "" for another screen's. */
const unprefixed = (action: NativeAction, prefix: string) =>
	typeof action.itemId === "string" && action.itemId.startsWith(prefix) ? action.itemId.slice(prefix.length) : "";

export class NativeSettingsView extends NativeFlow {
	private readonly options: NativeSettingsOptions;
	private readonly stack: Frame[] = [];
	private finish: (() => void) | undefined;
	/** The domain shown, in the "sections" layout. */
	private section = "";
	private busy = false;
	private errors: string[] = [];
	/** what the window's settings search looks for, across every domain ("" when it is not searching). */
	private query = "";

	constructor(changed: () => void, options: NativeSettingsOptions) {
		super(changed, { screenId: "loading", kind: "detail", title: t("Settings"), busy: true });
		this.options = options;
	}

	/** Until Close on the domains, the panel closes, or `stop`. */
	run(): Promise<void> {
		return this.wait<void>((finish) => {
			this.finish = () => finish(undefined);
			const { domain, item, open } = this.options.start ?? {};
			if (this.options.layout === "sections") {
				this.section = domain ?? "";
				this.stack.push(this.sectionFrame());
				const row = item ? this.domainItems(this.section).find((i) => i.id === item) : undefined;
				if (open && row && rowKind(row) === "page") this.openPage(row, (value) => this.apply(row, value));
				this.render();
				return () => this.options.onClose();
			}
			this.stack.push(this.domainsFrame());
			if (domain && this.options.model.domains().some((d) => d.id === domain)) {
				this.stack.push(this.domainFrame(domain));
				const row = item ? this.domainItems(domain).find((i) => i.id === item) : undefined;
				if (open && row && rowKind(row) === "page") this.openPage(row, (value) => this.apply(row, value));
			}
			this.render();
			return () => this.options.onClose();
		});
	}

	/** Ends the settings, as Close does (a row that runs a command). */
	stop(): void {
		this.stack.length = 0;
		this.finish?.();
	}

	/** Draws the screen shown again, after a page changed on its own (a value read or saved in the background). */
	refresh(): void {
		if (this.stack.length > 0) this.render();
	}

	private render(): void {
		while (!this.closed) {
			const top = this.stack.at(-1);
			if (!top) {
				this.finish?.();
				return;
			}
			const shown = top(this.nextPrefix());
			if (shown && this.options.layout === "sections") {
				this.show(
					{
						...shown.screen,
						...(this.errors.length ? { errors: this.errors } : {}),
						sections: this.options.model.domains().map((domain) => ({
							id: domain.id,
							label: t(domain.label),
							description: t(domain.description),
						})),
						section: this.section,
						...(this.query ? { searching: this.query } : {}),
						// The domain itself: the dialog closes it, there is no screen behind it to go back to.
						root: this.stack.length === 1,
						// the Simple │ Advanced switch the terminal shows in the title
						// row, always at hand in the window too, not only as a setting of the Interface domain.
						interfaceMode: this.options.model.isAdvanced() ? "advanced" : "simple",
					},
					(action) =>
						this.dispatch(() =>
							action.kind === "section"
								? this.jump(action.sectionId)
								: action.kind === "search"
									? this.search(action.query)
									: action.kind === "interface-mode"
										? this.switchMode(action.value)
										: shown.handle(action),
						),
				);
				return;
			}
			if (shown) {
				this.show({ ...shown.screen, ...(this.errors.length ? { errors: this.errors } : {}) }, (action) =>
					this.dispatch(() => shown.handle(action)),
				);
				return;
			}
			this.stack.pop();
		}
	}

	private dispatch(run: () => boolean | Promise<boolean>): boolean {
		if (this.busy) return false;
		this.errors = [];
		const result = run();
		if (!(result instanceof Promise)) return result;
		this.busy = true;
		void result
			.catch((error: unknown) => {
				this.errors = [error instanceof Error ? error.message : String(error)];
			})
			.finally(() => {
				this.busy = false;
				this.refresh();
			});
		return true;
	}

	/**
	 * Another domain of the "sections" layout. A page open in this one is left as Back leaves it, its own cancel
	 * included (the theme's preview is undone), before the domain changes.
	 */
	private jump(id: unknown): boolean {
		if (typeof id !== "string" || !this.options.model.domains().some((d) => d.id === id)) return false;
		for (let depth = this.stack.length; depth > 1; depth = this.stack.length) {
			this.handleNativeMenuInput({ kind: "back" });
			if (this.stack.length >= depth) break;
		}
		this.section = id;
		this.query = "";
		this.stack.length = 0;
		this.stack.push(this.sectionFrame());
		this.render();
		return true;
	}

	/**
	 * the window's settings search, as the terminal's: the settings of every domain
	 * whose name, description or domain holds each word, changed in place. A page open is left as Back leaves it; an
	 * empty query comes back to the domain shown before.
	 */
	private search(query: unknown): boolean {
		if (typeof query !== "string") return false;
		for (let depth = this.stack.length; depth > 1; depth = this.stack.length) {
			this.handleNativeMenuInput({ kind: "back" });
			if (this.stack.length >= depth) break;
		}
		this.query = query.trim();
		this.stack.length = 0;
		this.stack.push(this.query ? this.searchFrame() : this.sectionFrame());
		this.render();
		return true;
	}

	private searchFrame(): Frame {
		const frame: Frame = (prefix) => {
			const words = fold(this.query).split(/\s+/).filter(Boolean);
			const found: Array<{ item: SettingItem; domain: string }> = [];
			const seen = new Set<string>();
			for (const domain of this.options.model.domains()) {
				for (const item of [...domain.items(), ...domain.searchItems()]) {
					const text = fold(`${item.label} ${item.description ?? ""} ${t(domain.label)}`);
					if (seen.has(item.id) || !words.every((word) => text.includes(word))) continue;
					seen.add(item.id);
					found.push({ item, domain: t(domain.label) });
				}
			}
			const groups = new Map(found.map(({ item, domain }) => [item.id, domain]));
			const shown = this.rows(
				prefix,
				"settings:search",
				t("Search results"),
				found.length ? "" : t("No setting matches."),
				found.map(({ item }) => item),
				{ change: (item, value) => this.apply(item, value), close: () => this.search("") },
				(item) => groups.get(item.id),
			);
			return shown && { ...shown, screen: { ...shown.screen, enableSearch: false } };
		};
		return frame;
	}

	/**
	 * The interface mode from the window's switch, as the Interface setting changes it. A domain left without
	 * settings by the simple interface gives way to the first one (`sectionFrame`); a page open in it is left.
	 */
	private switchMode(value: unknown): boolean | Promise<boolean> {
		if (value !== "simple" && value !== "advanced") return false;
		if ((value === "advanced") === this.options.model.isAdvanced()) return true;
		// The Interface row keeps its value on the item, as a change made in it does (`apply`).
		for (const domain of this.options.model.domains())
			for (const item of domain.items()) if (item.id === "interface-mode") item.currentValue = value;
		const changed = this.options.model.onChange("interface-mode", value);
		const redraw = () => {
			if (!this.options.model.domains().some((d) => d.id === this.section)) this.stack.length = 1;
			this.render();
			return true;
		};
		return changed instanceof Promise ? changed.then(redraw) : redraw();
	}

	/** The domain of the "sections" layout; the first one when it is gone (the simple interface left it out). */
	private sectionFrame(): Frame {
		const frame: Frame = (prefix) => {
			const domains = this.options.model.domains();
			const domain = domains.find((d) => d.id === this.section) ?? domains[0];
			if (!domain) return undefined;
			this.section = domain.id;
			return this.rows(prefix, `settings:${domain.id}`, t(domain.label), t(domain.description), domain.items(), {
				change: (item, value) => this.apply(item, value),
				close: () => this.pop(frame),
			});
		};
		return frame;
	}

	/** Removes `frame` and every frame opened from it, then draws what is left. */
	private pop(frame: Frame): void {
		const at = this.stack.indexOf(frame);
		if (at !== -1) this.stack.length = at;
		this.render();
	}

	private domainItems(id: string): SettingItem[] {
		return (
			this.options.model
				.domains()
				.find((d) => d.id === id)
				?.items() ?? []
		);
	}

	private domainsFrame(): Frame {
		const frame: Frame = (prefix) => ({
			screen: {
				screenId: "settings:domains",
				kind: "choice",
				title: t("Settings"),
				hint: "close",
				items: this.options.model.domains().map((domain) => ({
					id: prefix + domain.id,
					label: t(domain.label),
					description: t(domain.description),
				})),
			},
			handle: (action) => {
				if (action.kind === "back") {
					this.pop(frame);
					return true;
				}
				const id = unprefixed(action, prefix);
				if (action.kind !== "activate" || !this.options.model.domains().some((d) => d.id === id)) return false;
				this.stack.push(this.domainFrame(id));
				this.render();
				return true;
			},
		});
		return frame;
	}

	/** A domain's settings; the interface mode can take the domain away (all its settings advanced). */
	private domainFrame(id: string): Frame {
		const frame: Frame = (prefix) => {
			const domain = this.options.model.domains().find((d) => d.id === id);
			if (!domain) return undefined;
			return this.rows(prefix, `settings:${id}`, t(domain.label), t(domain.description), domain.items(), {
				change: (item, value) => this.apply(item, value),
				close: () => this.pop(frame),
			});
		};
		return frame;
	}

	/** A setting changed in a domain: the model applies it, as the terminal's SettingsView does. */
	private apply(item: SettingItem, value: string | undefined): void | Promise<void> {
		if (value === undefined) return;
		item.currentValue = value;
		return this.options.model.onChange(item.id, value);
	}

	/** Settings as rows: a list for a choice, a button for an action or a page, text for the others. */
	private rows(
		prefix: string,
		screenId: string,
		title: string,
		description: string,
		items: SettingItem[],
		on: { change(item: SettingItem, value: string): void | Promise<void>; close(): void },
		groupOf?: (item: SettingItem) => string | undefined,
	): ReturnType<Frame> {
		return {
			screen: {
				screenId,
				kind: "settings",
				title,
				// A page's description may hold several paragraphs, one per line.
				lines: description ? description.split("\n") : [],
				enableSearch: items.length > 6,
				items: items.map((item) => {
					const kind = rowKind(item);
					return {
						id: prefix + item.id,
						label: plain(item.label),
						// the mark apart from the name, so the window shows it in colour after it.
						...(this.options.model.stateTag?.(item.id) ? { stateTag: this.options.model.stateTag(item.id) } : {}),
						description: plain(item.description),
						...(groupOf?.(item) ? { group: groupOf(item) } : {}),
						// Values chosen in place are saved untranslated (settings-domains.ts, shown); an action row shows its
						// one value, translated as in the terminal (settings-view.ts).
						currentValue:
							kind === "action"
								? t(item.values![0]!)
								: t(plain(item.currentValue) ?? "") || (kind === "page" ? t("Open") : ""),
						...(kind === "choice" ? { values: item.values!.map((value) => t(value)) } : {}),
						...(kind === "info" || (kind === "page" && !this.pageFor(item)) ? { disabled: true } : {}),
					};
				}),
			},
			handle: (action) => {
				if (action.kind === "back") {
					on.close();
					return true;
				}
				const item = items.find((row) => row.id === unprefixed(action, prefix));
				if (action.kind !== "setting" || !item) return false;
				const kind = rowKind(item);
				let saving: void | Promise<void> | undefined;
				if (kind === "page") {
					if (!this.pageFor(item)) return false;
					this.openPage(item, (value) => {
						if (value !== undefined) on.change(item, value);
					});
				} else if (kind === "action") {
					saving = on.change(item, item.values![0]!);
				} else if (kind === "choice") {
					// The window shows translated values: the setting receives its own.
					const value = item.values!.find((candidate) => t(candidate) === action.value);
					if (value === undefined) return false;
					if (value !== item.currentValue) saving = on.change(item, value);
				} else return false;
				if (saving instanceof Promise)
					return saving.then(() => {
						this.refresh();
						return true;
					});
				// A row that runs a command has ended the settings.
				if (this.stack.length > 0) this.render();
				return true;
			},
		};
	}

	private pageFor(item: SettingItem): SettingsPageFactory | undefined {
		return pageOf(item);
	}

	/** Opens a setting's page; `done` gets the value it closed with, as a submenu's caller does. */
	private openPage(item: SettingItem, done: (value: string | undefined) => void): void {
		const factory = this.pageFor(item);
		if (!factory) return;
		let frame: Frame | undefined;
		const page = factory(item.currentValue, (value) => {
			const at = frame ? this.stack.indexOf(frame) : -1;
			if (at !== -1) this.stack.length = at;
			done(value);
			if (this.stack.length > 0) this.render();
		});
		frame = this.pageFrame(page);
		this.stack.push(frame);
	}

	private pageFrame(page: SettingsPage): Frame {
		switch (page.kind) {
			case "select":
				return this.selectFrame(
					page.title,
					page.description,
					page.options,
					page.current,
					page.onSelect,
					page.onCancel,
				);
			case "rows":
				return (prefix) =>
					this.rows(prefix, `settings-page:${page.title}`, t(page.title), t(page.description), page.items, {
						change: (item, value) => {
							item.currentValue = value;
							return page.onChange(item.id, value);
						},
						close: page.onClose,
					});
			case "text":
				return () => ({
					screen: {
						screenId: `settings-page:${page.title}`,
						kind: "detail",
						title: t(page.title),
						lines: page.lines.map((line) => stripAnsi(line)),
					},
					handle: (action) => {
						if (action.kind !== "back") return false;
						page.done();
						return true;
					},
				});
			case "input": {
				const { input } = page;
				return this.inputFrame(input.title, input.description, input.current, input.parse, {
					save: async (value) => {
						await input.save(value);
						input.done(true);
					},
					cancel: () => input.done(false),
				});
			}
			case "list":
				return this.listFrame(page.list);
			case "steps":
				return this.stepsFrame(page);
		}
	}

	/** One value among `options`; the page's callbacks close it or open the next one. */
	private selectFrame(
		title: string,
		description: string,
		options: SelectItem[],
		current: string,
		select: (value: string) => void | Promise<void>,
		cancel: () => void,
	): Frame {
		return (prefix) => ({
			screen: {
				screenId: `settings-page:${title}`,
				kind: "choice",
				title: t(title),
				lines: description ? [t(description)] : [],
				currentItemId: prefix + current,
				items: options.map((option) => ({
					id: prefix + option.value,
					label: plain(option.label) || option.value,
					description: plain(option.description),
				})),
			},
			handle: (action) => {
				if (action.kind === "back") {
					cancel();
					return true;
				}
				const value = unprefixed(action, prefix);
				if (action.kind !== "activate" || !options.some((option) => option.value === value)) return false;
				const selected = select(value);
				if (selected instanceof Promise)
					return selected.then(() => {
						if (this.stack.length > 0) this.render();
						return true;
					});
				if (this.stack.length > 0) this.render();
				return true;
			},
		});
	}

	/** A typed value: `parse` says what is expected; an empty field removes the value unless `required`. */
	private inputFrame(
		title: string,
		description: string,
		current: string | undefined,
		parse: ((text: string) => string | Error) | undefined,
		on: { save(value: string | undefined): void | Promise<void>; cancel(): void },
		required = false,
	): Frame {
		let errors: string[] = [];
		return () => ({
			screen: {
				screenId: `settings-input:${title}`,
				kind: "input",
				title: t(title),
				lines: [t(description), ...(current === undefined ? [] : [`${t("Now")}: ${t(current)}`])],
				errors,
			},
			handle: (action) => {
				if (action.kind === "back") {
					on.cancel();
					return true;
				}
				if (action.kind !== "input" || typeof action.value !== "string") return false;
				const text = action.value.trim();
				const value = text === "" ? undefined : parse ? parse(text) : text;
				if (value instanceof Error) errors = [value.message];
				else if (value === undefined && required) errors = [t("Type a value.")];
				else {
					try {
						const saved = on.save(value);
						if (saved instanceof Promise)
							return saved.then(
								() => true,
								(error: unknown) => {
									errors = [error instanceof Error ? error.message : String(error)];
									this.render();
									return true;
								},
							);
						return true;
					} catch (error) {
						errors = [error instanceof Error ? error.message : String(error)];
					}
				}
				this.render();
				return true;
			},
		});
	}

	/** Entries with Add… first; Enter on an entry asks to remove it. Entries Prism always applies stay. */
	private listFrame(list: Extract<SettingsPage, { kind: "list" }>["list"]): Frame {
		let changed = false;
		let errors: string[] = [];
		const attempt = async (operation: () => void | Promise<void>) => {
			try {
				await operation();
				changed = true;
				errors = [];
			} catch (error) {
				errors = [error instanceof Error ? error.message : String(error)];
			}
		};
		return (prefix) => {
			const entries = list.entries();
			return {
				screen: {
					screenId: `settings-list:${list.title}`,
					kind: "choice",
					title: t(list.title),
					lines: [t(list.description)],
					errors,
					items: [
						{ id: `${prefix}add`, label: t("Add…") },
						...entries.map((entry, index) => ({
							id: `${prefix}${index}`,
							label: entry.text,
							description: entry.tag,
							...(entry.fixed ? { disabled: true } : {}),
						})),
					],
				},
				handle: (action) => {
					if (action.kind === "back") {
						list.done(changed);
						return true;
					}
					if (action.kind !== "activate") return false;
					const id = unprefixed(action, prefix);
					if (id === "add") {
						const input: Frame = this.inputFrame(
							list.title,
							list.addPrompt,
							undefined,
							list.parse,
							{
								save: async (text) =>
									await this.askSteps(list.steps?.() ?? [], async (choices) => {
										await attempt(() => list.onAdd(text!, choices));
										this.pop(input);
									}),
								cancel: () => this.pop(input),
							},
							true,
						);
						this.stack.push(input);
						this.render();
						return true;
					}
					const entry = id === "" ? undefined : entries[Number(id)];
					if (!entry || entry.fixed) return false;
					this.stack.push(
						this.confirmFrame(
							`${t("Remove")} ${entry.text}?`,
							async () => await attempt(() => list.onRemove(entry)),
						),
					);
					this.render();
					return true;
				},
			};
		};
	}

	/** The choices a new entry needs, one screen each, then `add`; Back returns to the previous screen. */
	private async askSteps(steps: ListStep[], add: (choices: string[]) => void | Promise<void>): Promise<void> {
		const choices: string[] = [];
		const ask = async (index: number) => {
			const step = steps[index];
			if (!step) {
				await add(choices);
				return;
			}
			const frame = this.selectFrame(
				step.title,
				"",
				step.options,
				"",
				async (value) => {
					choices[index] = value;
					await ask(index + 1);
				},
				() => this.pop(frame),
			);
			this.stack.push(frame);
			this.render();
		};
		await ask(0);
	}

	private confirmFrame(question: string, confirm: () => void | Promise<void>): Frame {
		const frame: Frame = (prefix) => ({
			screen: {
				screenId: "settings-confirm",
				kind: "choice",
				title: question,
				items: [
					{ id: `${prefix}yes`, label: t("Remove") },
					{ id: `${prefix}no`, label: t("Cancel") },
				],
			},
			handle: (action) => {
				if (action.kind !== "back" && action.kind !== "activate") return false;
				if (action.kind === "activate" && action.itemId === `${prefix}yes`) {
					const confirmed = confirm();
					if (confirmed instanceof Promise)
						return confirmed.then(() => {
							this.pop(frame);
							return true;
						});
				}
				this.pop(frame);
				return true;
			},
		});
		return frame;
	}

	/** Values chosen one after the other, as SteppedSubmenu asks them. */
	private stepsFrame(page: Extract<SettingsPage, { kind: "steps" }>): Frame {
		let context: Record<string, string> = { ...(page.stepsOptions?.initialContext ?? {}) };
		let index = page.stepsOptions?.startAtStep ?? 0;
		const total = page.steps.length;
		return (prefix) => {
			const step = page.steps[index];
			if (!step) return undefined;
			const title = typeof step.title === "function" ? step.title(context) : step.title;
			const description = typeof step.description === "function" ? step.description(context) : step.description;
			const options = step.options(context);
			return {
				screen: {
					screenId: `settings-step:${step.key}`,
					kind: "choice",
					title: t(title),
					lines: [`${total > 1 ? t(`Step ${index + 1}/${total} · `) : ""}${t(description)}`],
					currentItemId: prefix + (step.preselect?.(context) ?? ""),
					items: options.map((option) => ({
						id: prefix + option.value,
						label: plain(option.label) || option.value,
						description: plain(option.description),
					})),
				},
				handle: (action) => {
					if (action.kind === "back") {
						if (index > 0) {
							delete context[step.key];
							index--;
							this.render();
						} else page.onCancel();
						return true;
					}
					const value = unprefixed(action, prefix);
					if (action.kind !== "activate" || !options.some((option) => option.value === value)) return false;
					context[step.key] = value;
					if (index < total - 1) index++;
					else {
						page.onComplete({ ...context });
						if (!page.stepsOptions?.loop) {
							page.onCancel();
							return true;
						}
						context = {};
						index = 0;
					}
					this.render();
					return true;
				},
			};
		};
	}
}

/**
 * Settings only the terminal draws or reads, which the window has nothing to apply to: the window leaves them out
 * its startup print, its warnings and changelog at startup, its cache notes in the
 * conversation, its inline images and the Prism look of the terminal. Its theme too: the
 * window shows Prism's light or dark theme, as Window › Theme chooses.
 */
const TERMINAL_ONLY_DOMAINS = new Set(["terminal"]);
const TERMINAL_ONLY_SETTINGS = new Set([
	"animations",
	"theme",
	"theme-customize",
	"show-hardware-cursor",
	"editor-padding",
	"output-padding",
	"quiet-startup",
	"warnings",
	"collapse-changelog",
	"cache-miss-notices",
	"show-images",
	"image-width-cells",
	"builtin:prism",
]);

/** What a domain holds in the window, where the terminal's description names settings left out. */
const WINDOW_DOMAIN_DESCRIPTIONS: Record<string, string> = {
	appearance: "Thinking text, diagrams and suggestions",
};

/**
 * `model` without the terminal's own settings, each domain described by what it keeps; a domain left with nothing
 * is left out.
 */
export function windowSettingsModel(model: SettingsModel): SettingsModel {
	const kept = (items: SettingItem[]) => items.filter((item) => !TERMINAL_ONLY_SETTINGS.has(item.id));
	return {
		...model,
		domains: () =>
			model
				.domains()
				.filter((domain) => !TERMINAL_ONLY_DOMAINS.has(domain.id))
				.map((domain) => ({
					...domain,
					description: WINDOW_DOMAIN_DESCRIPTIONS[domain.id] ?? domain.description,
					items: () => kept(domain.items()),
					searchItems: () => kept(domain.searchItems()),
				}))
				.filter((domain) => domain.items().length > 0),
	};
}

/** Shows `/settings` in one native panel until it is closed; `opened` gets the view, to `stop` it. */
export function showNativeSettings(
	ctx: ExtensionContext,
	options: NativeSettingsOptions,
	opened?: (view: NativeSettingsView) => void,
): Promise<void> {
	return showNativeFlow<NativeSettingsView>(
		ctx,
		(changed) => {
			const view = new NativeSettingsView(changed, options);
			opened?.(view);
			return view;
		},
		(view) => view.run(),
	);
}

/**
 * `/settings` for the Prism window: the terminal's operations with what the window cannot draw left out (its
 * footer, editor and renderer). A row that runs a command, and `/web-key`, end the settings with the line to run;
 * modules turned on or off, and a new search provider, reload the session once the settings are closed.
 */
export async function runNativeSettings(
	session: AgentSession,
	ctx: ExtensionContext,
	reload: () => Promise<void>,
	start?: NativeSettingsOptions["start"],
	layout?: NativeSettingsOptions["layout"],
): Promise<{ line?: string; reloaded?: boolean }> {
	const settings = session.settingsManager;
	let view: NativeSettingsView | undefined;
	let line: string | undefined;
	let reloadAfter = false;
	const end = (next?: string) => {
		line = next;
		view?.stop();
	};
	const { config, callbacks } = await settingsOperations(session, {
		view: {
			// The theme setting is the terminal's alone, left out of the window (TERMINAL_ONLY_SETTINGS).
			currentTheme: settings.getThemeSetting() || SYSTEM_THEME_NAME,
			terminalTheme: "dark",
			hideThinkingBlock: settings.getHideThinkingBlock(),
			tuiMode: settings.getTuiMode(),
		},
		effects: {},
		onWebSearchKey: (action) => end(action === "remove" ? "/web-key remove" : "/web-key"),
		onWebSearchReload: () => {
			reloadAfter = true;
			end();
		},
		requestRender: () => view?.refresh(),
		notify: (message, type) => ctx.ui.notify(message, type),
		warn: (message) => ctx.ui.notify(message, "warning"),
		onRunCommand: (command) => end(`/${command}`),
		reload: () => {
			reloadAfter = true;
		},
	});
	const { items, onChange } = settingsItems(config, callbacks);
	await showNativeSettings(
		ctx,
		{
			model: windowSettingsModel(groupSettingsByDomain(items, onChange, config.domainExtras!)),
			start,
			layout,
			onClose: callbacks.onCancel,
		},
		(opened) => {
			view = opened;
		},
	);
	// A reload while a reply runs is refused: the modules apply at the next /reload (settings-operations.ts warns).
	if (reloadAfter && !session.isStreaming && !session.isCompacting) {
		await reload();
		return { ...(line ? { line } : {}), reloaded: true };
	}
	return line ? { line } : {};
}
