/**
 * fork: each model's page in the Models domain of `/settings`
 * , with the rows `/model-settings` showed alone before: what the server reports next to what Prism
 * sends or assumes. Enter edits the Prism value in place; an empty value removes the correction. The simple
 * interface shows the rows up to Tool calls, the advanced one adds sampling and the other request parameters.
 * The search finds each row of each model ("max output" lists the models) and opens the page on it.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type Component,
	getKeybindings,
	Input,
	type SettingItem,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { theme } from "../modes/interactive/theme/theme.ts";
import { SAMPLING_KEYS } from "./capabilities.ts";
import { readAllCapabilities, readCapabilities } from "./capability-store.ts";
import { fill, t } from "./i18n/index.ts";
import {
	clearModelCorrection,
	parseSettingValue,
	type RowKey,
	readAllCorrections,
	readModelCorrection,
	type ServerValues,
	type SettingRow,
	type SettingValue,
	saveSetting,
	settingRows,
} from "./model-settings.ts";
import { modelKey } from "./settings-models.ts";
import { pageComponent, paged, type SettingsPage, type SettingsPageFactory, withPage } from "./settings-pages.ts";
import type { SectionContext, SettingsSection } from "./settings-sections.ts";

/** What the page reads and changes; the extension passes the session's registry and files. */
export interface ModelPageDeps {
	modelsPath: string;
	capabilitiesFile: string;
	/** The models the domain lists, as `/model` does. */
	models(): Model<Api>[];
	current(): Model<Api> | undefined;
	/** What the server reports, or undefined for a provider that is not a server in models.json. */
	readServer(model: Model<Api>): Promise<ServerValues | undefined>;
	/** Reloads the model after a change (and makes it current again if it was); the updated model. */
	reload(model: Model<Api>): Promise<Model<Api> | undefined>;
	/** the models models.json lists for the model's provider, or undefined for a built-in provider. */
	serverModels?(model: Model<Api>): string[] | undefined;
	/** removes the model (with `server`, its whole server) from models.json; what to tell the user. */
	remove?(model: Model<Api>, server: boolean): Promise<string>;
	/**
	 * reads the server's model list again (models.json follows it); what to tell the user, and whether
	 * this model is gone.
	 */
	syncServer?(model: Model<Api>): Promise<{ message: string; gone: boolean }>;
}

type PageActionId = "clear" | "sync-server" | "remove-model" | "remove-server";

/**
 * The actions under a model's rows: "Remove my changes" when there are some; for a model of a server models.json
 * lists, removing the model or its whole server.
 */
function pageActions(
	deps: ModelPageDeps,
	model: Model<Api>,
	rows: SettingRow[],
): { id: PageActionId; label: string; confirm: string }[] {
	const actions: { id: PageActionId; label: string; confirm: string }[] = [];
	if (changesOf(rows) > 0)
		actions.push({
			id: "clear",
			label: t("Remove my changes for this model"),
			confirm: t("Enter again removes your changes, Esc keeps them"),
		});
	const listed = deps.remove ? deps.serverModels?.(model) : undefined;
	if (listed?.includes(model.id)) {
		if (deps.syncServer)
			actions.push({
				id: "sync-server",
				label: fill("Update the model list of the server {0}", model.provider),
				confirm: "",
			});
		actions.push({
			id: "remove-model",
			label: t("Remove this model from Prism"),
			confirm: t("Enter again removes this model from Prism, Esc keeps it"),
		});
		actions.push({
			id: "remove-server",
			label: fill("Remove the server {0} and its {1} model(s)", model.provider, String(listed.length)),
			confirm: t("Enter again removes the server and its models, Esc keeps them"),
		});
	}
	return actions;
}

/** Rows the simple interface leaves out: sampling and the other request parameters. */
const ADVANCED_ROWS = new Set<RowKey>([...SAMPLING_KEYS, "extra"]);

/** What each row is, shown under the page for the focused row. */
const ROW_HELP: Record<RowKey, string> = {
	name: "The name Prism shows for this model.",
	contextWindow:
		"How many tokens the model reads at once; the conversation is compacted before it is full. The server keeps its own limit.",
	maxTokens: "The longest answer the model may write, in tokens.",
	vision: "Whether Prism sends images to this model.",
	toolImages:
		"Keeps the images a tool returns (a screenshot) in the tool's result, instead of a separate message the model may take for one from you. Recommended for the Qwen family. The server must accept it: llama.cpp does, OpenAI does not.",
	reasoning: "Whether the model can think before it answers. Off, Prism refuses a thinking level for it.",
	thinkingBudget: "Tokens the model may spend thinking, at every level, when the server reads a budget.",
	tools: "Whether Prism gives this model its tools. Off for a model that cannot call them.",
	temperature: "Sampling parameter sent with each request. Not sent: the server's default applies.",
	top_p: "Sampling parameter sent with each request. Not sent: the server's default applies.",
	top_k: "Sampling parameter sent with each request. Not sent: the server's default applies.",
	min_p: "Sampling parameter sent with each request. Not sent: the server's default applies.",
	presence_penalty: "Sampling parameter sent with each request. Not sent: the server's default applies.",
	frequency_penalty: "Sampling parameter sent with each request. Not sent: the server's default applies.",
	repeat_penalty: "Sampling parameter sent with each request. Not sent: the server's default applies.",
	extra: 'Other request fields, as a JSON object, for example {"seed": 42}.',
};

const ROW_PREFIX = "model:";
/** Separates the model from the row in a search row's id; model ids may hold ":" (Ollama tags). */
const ROW_SEPARATOR = "#";

export const modelRowId = (model: Model<Api>) => `${ROW_PREFIX}${modelKey(model)}`;

/** "current · 2 changes", translated when drawn (fr.ts patterns). */
function summary(current: boolean, changes: number): string {
	const count = changes === 0 ? "" : changes === 1 ? "1 change" : `${changes} changes`;
	return [current ? "current" : "", count].filter(Boolean).join(" · ");
}

const changesOf = (rows: SettingRow[]) => rows.filter((row) => row.corrected).length;

function fitCell(text: string, width: number): string {
	const cut = truncateToWidth(text, Math.max(0, width), "…");
	return `${cut}${" ".repeat(Math.max(0, width - visibleWidth(cut)))}`;
}

/**
 * fork: removing the saved default model, or its server, left settings.json naming a
 * model that no longer exists, and every start opened on another one without a word. The removal now says so and
 * offers another default among the models left; Esc leaves it (the start then says which model it uses).
 */
type DefaultModelAccess = NonNullable<SectionContext["defaultModel"]>;

/** Whether `model` (with `server`, its whole server) is, or holds, the saved default model. */
function holdsDefault(access: DefaultModelAccess | undefined, model: Model<Api>, server: boolean): boolean {
	const saved = access?.get();
	if (!saved || saved.provider !== model.provider) return false;
	return server || saved.id === model.id;
}

/** The models left to choose from once `model` (with `server`, its whole server) is removed. */
function modelsLeft(deps: ModelPageDeps, model: Model<Api>, server: boolean): Model<Api>[] {
	return deps
		.models()
		.filter((other) => (server ? other.provider !== model.provider : modelKey(other) !== modelKey(model)));
}

const DEFAULT_REMOVED = "It was the default model for new conversations.";
const NO_DEFAULT_LEFT = "It was the default model for new conversations; no other model is available to replace it.";

/** The choice of another default model, as the Models domain's "Default model" page; `done` gets what to tell. */
function defaultChoicePage(
	models: Model<Api>[],
	intro: string,
	access: DefaultModelAccess,
	done: (message: string | undefined) => void,
): SettingsPage {
	return {
		kind: "select",
		title: t("Choose another default model"),
		description: [intro, t("Enter makes the chosen model the default; Esc leaves the default as it is.")]
			.filter(Boolean)
			.join(" "),
		options: models.map((model) => ({
			value: modelKey(model),
			label: `${model.id} ${theme.fg("muted", `[${model.provider}]`)}`,
		})),
		current: "",
		onSelect: (value) => {
			const chosen = models.find((model) => modelKey(model) === value);
			if (!chosen) return done(undefined);
			access.set(chosen);
			done(`${fill("Default model: {0}/{1}", chosen.provider, chosen.id)}.`);
		},
		onCancel: () => done(undefined),
		selectOptions: { searchable: true },
	};
}

export interface ModelPageOptions {
	/** The row to focus first. */
	focus?: RowKey;
	/** fork: the saved default model, to offer another one when this page removes it. */
	defaultModel?: DefaultModelAccess;
	advanced(): boolean;
	requestRender(): void;
	/** Closes the page; `value` is the row's new summary when something changed. */
	done(value?: string): void;
}

/** One model's page, drawn in place of the domain's settings. */
export class ModelPage implements Component {
	private readonly deps: ModelPageDeps;
	private readonly options: ModelPageOptions;
	private model: Model<Api>;
	private server: ServerValues | undefined | "reading" = "reading";
	private rows: SettingRow[] = [];
	private index = 0;
	private editing: Input | undefined;
	private confirming: PageActionId | undefined;
	private busy = false;
	private changed = false;
	private message: { text: string; kind: "warning" | "error" } | undefined;
	/** fork: the choice of another default model, shown in place of the page after its removal. */
	private chooser: Component | undefined;
	/** Page line → row index (rows.length and above are the actions), for the mouse. */
	private lineRows = new Map<number, number>();

	constructor(deps: ModelPageDeps, model: Model<Api>, options: ModelPageOptions) {
		this.deps = deps;
		this.options = options;
		this.model = model;
		this.read();
		const at = this.visibleRows().findIndex((row) => row.key === options.focus);
		this.index = Math.max(0, at);
		deps.readServer(model).then(
			(server) => this.serverRead(server),
			() => this.serverRead(undefined),
		);
	}

	private serverRead(server: ServerValues | undefined): void {
		this.server = server;
		this.read();
		this.options.requestRender();
	}

	private read(): void {
		const { modelsPath, capabilitiesFile } = this.deps;
		const server = this.server === "reading" ? undefined : this.server?.model;
		this.rows = settingRows(
			this.model,
			readModelCorrection(modelsPath, this.model.provider, this.model.id),
			server,
			readCapabilities(capabilitiesFile, this.model.provider, this.model.id),
		);
	}

	private visibleRows(): SettingRow[] {
		return this.options.advanced() ? this.rows : this.rows.filter((row) => !ADVANCED_ROWS.has(row.key));
	}

	/** Rows, then the actions. */
	private get count(): number {
		return this.visibleRows().length + pageActions(this.deps, this.model, this.rows).length;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.chooser) return this.chooser.render(width).map((line) => fitCell(line, width));
		const out: string[] = [];
		const add = (text: string) => out.push(fitCell(text, width));
		const wrap = (text: string) => {
			for (const l of wrapTextWithAnsi(text, width)) add(l);
		};
		const isCurrent = this.deps.current() !== undefined && modelKey(this.deps.current()!) === modelKey(this.model);
		add(
			`${theme.bold(theme.fg("accent", modelKey(this.model)))}${isCurrent ? theme.fg("muted", ` · ${t("current")}`) : ""}`,
		);
		wrap(theme.fg("muted", intro(this.server)));
		add("");

		const rows = this.visibleRows();
		// fork: up to half the page, so long translations ("Pénalité de répétition") stay whole.
		const labelWidth = Math.min(
			Math.max(...rows.map((row) => visibleWidth(row.label))) + 2,
			Math.max(20, Math.floor(width / 2) - 4),
		);
		const room = Math.max(10, width - 2 - labelWidth);
		const serverWidth = Math.min(18, Math.floor(room / 2));
		add(theme.fg("muted", `  ${" ".repeat(labelWidth)}${fitCell(t("Server"), serverWidth)} Prism`));
		this.lineRows.clear();
		rows.forEach((row, i) => {
			const selected = i === this.index;
			const server =
				this.server === "reading" ? t("reading…") : this.server ? (row.server ?? t("not reported")) : "—";
			const prism = `${row.prism}${row.corrected ? " ✎" : ""}`;
			const label = selected ? theme.bold(theme.fg("text", row.label)) : theme.fg("text", row.label);
			const marker = selected ? theme.fg("accent", "→ ") : "  ";
			this.lineRows.set(out.length, i);
			add(
				`${marker}${fitCell(label, labelWidth)}${fitCell(theme.fg("muted", server), serverWidth)} ${theme.fg(row.corrected ? "accent" : "text", prism)}`,
			);
		});
		if (!this.options.advanced()) {
			wrap(theme.fg("muted", `  … ${t("Advanced interface: sampling and the other request parameters")}`));
		}
		const actions = pageActions(this.deps, this.model, this.rows);
		if (actions.length > 0) add("");
		actions.forEach((action, i) => {
			const selected = this.index === rows.length + i;
			const text = this.confirming === action.id ? action.confirm : action.label;
			this.lineRows.set(out.length, rows.length + i);
			add(
				`${selected ? theme.fg("accent", "→ ") : "  "}${selected ? theme.bold(theme.fg("text", text)) : theme.fg("text", text)}`,
			);
		});
		add("");
		const row = rows[this.index];
		if (this.editing && row) {
			wrap(theme.fg("text", `${row.label}: ${t("new value for Prism")} (${t("empty: remove your correction")})`));
			for (const l of this.editing.render(width)) add(l);
		}
		if (this.message) wrap(theme.fg(this.message.kind, this.message.text));
		else if (row && !this.editing) wrap(theme.fg("thinkingText", `${t(ROW_HELP[row.key])} ${t("✎ = your value.")}`));
		return out;
	}

	handleInput(data: string): void {
		if (this.chooser) {
			this.chooser.handleInput?.(data);
			return;
		}
		if (this.busy) return;
		if (this.editing) {
			this.editing.handleInput(data);
			return;
		}
		const kb = getKeybindings();
		const confirm = kb.matches(data, "tui.select.confirm");
		if (this.confirming) {
			const action = this.confirming;
			this.confirming = undefined;
			if (confirm) void (action === "clear" ? this.clear() : this.remove(action === "remove-server"));
			return;
		}
		const count = this.count;
		if (kb.matches(data, "tui.select.up")) this.move((this.index - 1 + count) % count);
		else if (kb.matches(data, "tui.select.down")) this.move((this.index + 1) % count);
		else if (confirm || data === " ") this.activate();
		else if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.editor.cursorLeft")) this.close();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left" || this.busy || this.editing || this.chooser)
			return { handled: true };
		const index = this.lineRows.get(event.y);
		if (index === undefined) return { handled: true };
		this.confirming = undefined;
		this.move(index);
		this.activate();
		return { handled: true, render: true };
	}

	private move(index: number): void {
		this.index = index;
		this.message = undefined;
	}

	private close(): void {
		const current = this.deps.current();
		const isCurrent = current !== undefined && modelKey(current) === modelKey(this.model);
		this.options.done(this.changed ? summary(isCurrent, changesOf(this.rows)) : undefined);
	}

	private activate(): void {
		const rows = this.visibleRows();
		if (this.index >= rows.length) {
			const action = pageActions(this.deps, this.model, this.rows)[this.index - rows.length]?.id;
			// Reading the list again changes nothing the server does not say: no confirmation.
			if (action === "sync-server") void this.sync();
			else this.confirming = action;
			return;
		}
		const row = rows[this.index];
		if (!row) return;
		const input = new Input();
		input.focused = true;
		input.onEscape = () => {
			this.editing = undefined;
			this.options.requestRender();
		};
		input.onSubmit = (typed) => {
			const value = typed.trim() === "" ? undefined : parseSettingValue(row.key, typed);
			if (value instanceof Error) {
				this.message = { text: value.message, kind: "warning" };
				this.options.requestRender();
				return;
			}
			this.editing = undefined;
			void this.save(row.key, value);
		};
		this.message = undefined;
		this.editing = input;
	}

	private async save(key: RowKey, value: SettingValue | undefined): Promise<void> {
		const server = this.server === "reading" ? undefined : this.server;
		await this.write(async () => await saveSetting(this.deps, this.model, key, value, server?.kind));
	}

	private async clear(): Promise<void> {
		await this.write(async () => {
			await clearModelCorrection(this.deps.modelsPath, this.model.provider, this.model.id);
			await saveSetting(this.deps, this.model, "tools", undefined, undefined);
			return undefined;
		});
		this.index = Math.min(this.index, this.count - 1);
	}

	/** Reads the server's model list again; closes the page when this model is no longer served. */
	private async sync(): Promise<void> {
		this.busy = true;
		this.message = { text: t("Reading the server's model list…"), kind: "warning" };
		this.options.requestRender();
		try {
			const { message, gone } = await this.deps.syncServer!(this.model);
			this.busy = false;
			if (gone) {
				this.options.done(message);
				this.options.requestRender();
				return;
			}
			this.message = { text: message, kind: "warning" };
		} catch (error) {
			this.busy = false;
			this.message = { text: error instanceof Error ? error.message : String(error), kind: "error" };
		}
		this.read();
		this.options.requestRender();
	}

	/**
	 * Removes the model, or its whole server, then closes the page: the domain no longer lists it. When it held the
	 * default model, the choice of another one comes first.
	 */
	private async remove(server: boolean): Promise<void> {
		this.busy = true;
		try {
			const access = this.options.defaultModel;
			const held = holdsDefault(access, this.model, server);
			const message = await this.deps.remove!(this.model, server);
			this.busy = false;
			const left = held ? modelsLeft(this.deps, this.model, server) : [];
			if (access && left.length > 0) {
				const intro = `${message} ${t(DEFAULT_REMOVED)}`;
				this.chooser = pageComponent(
					defaultChoicePage(left, intro, access, (chosen) => {
						this.chooser = undefined;
						this.options.done(chosen ? `${message} ${chosen}` : message);
						this.options.requestRender();
					}),
				);
				this.options.requestRender();
				return;
			}
			this.options.done(held ? `${message} ${t(NO_DEFAULT_LEFT)}` : message);
			this.options.requestRender();
		} catch (error) {
			this.busy = false;
			this.message = { text: error instanceof Error ? error.message : String(error), kind: "error" };
			this.options.requestRender();
		}
	}

	/** Runs a write, reloads the model and redraws; a failure is shown on the page. */
	private async write(change: () => Promise<string | undefined>): Promise<void> {
		this.busy = true;
		try {
			const warning = await change();
			this.changed = true;
			this.model = (await this.deps.reload(this.model)) ?? this.model;
			this.message = warning ? { text: warning, kind: "warning" } : undefined;
		} catch (error) {
			this.message = { text: error instanceof Error ? error.message : String(error), kind: "error" };
		} finally {
			this.busy = false;
			this.read();
			this.options.requestRender();
		}
	}
}

/** The page's intro: where the server column comes from. */
function intro(server: ServerValues | undefined | "reading"): string {
	return server === "reading"
		? t("Reading the server's values…")
		: server
			? t(
					`server: what ${server.kind} reports. Prism: what Prism sends or assumes; changing it does not change the server.`,
				)
			: t("This provider does not report its settings: only Prism's values are shown.");
}

/**
 * the same page for the Prism window, as rows: each opens a field for Prism's value, and "Remove my
 * changes" asks first. Saving writes as ModelPage does, then reloads the model in the background and redraws.
 */
function modelSettingsPage(deps: ModelPageDeps, model: Model<Api>, context: SectionContext): SettingsPageFactory {
	return (_value, done) => {
		let current = model;
		let server: ServerValues | undefined | "reading" = "reading";
		let changed = false;
		let message: string | undefined;
		// once the model or its server is removed, the page says so and offers nothing more.
		let removed = false;
		// fork: the models to choose another default from, when the removal took the default.
		let defaultChoices: Model<Api>[] = [];
		const read = () =>
			settingRows(
				current,
				readModelCorrection(deps.modelsPath, current.provider, current.id),
				server === "reading" ? undefined : server?.model,
				readCapabilities(deps.capabilitiesFile, current.provider, current.id),
			);
		const page: Extract<SettingsPage, { kind: "rows" }> = {
			kind: "rows",
			title: modelKey(model),
			description: "",
			items: [],
			onChange: (id) => {
				if (id !== "sync-server" || removed) return;
				message = t("Reading the server's model list…");
				refresh();
				context.requestRender();
				deps.syncServer!(current)
					.then(
						(result) => {
							message = result.message;
							removed = result.gone;
						},
						(error: unknown) => {
							message = error instanceof Error ? error.message : String(error);
						},
					)
					.finally(() => {
						refresh();
						context.requestRender();
					});
			},
			onClose: () => {
				if (removed) return done(message);
				const active = deps.current();
				const isCurrent = active !== undefined && modelKey(active) === modelKey(current);
				done(changed ? summary(isCurrent, changesOf(read())) : undefined);
			},
		};
		/** Reloads the model after a write, then draws the page again with its values. */
		const reloaded = (warning: string | undefined) => {
			changed = true;
			message = warning;
			deps
				.reload(current)
				.then(
					(updated) => {
						current = updated ?? current;
					},
					(error: unknown) => {
						message = error instanceof Error ? error.message : String(error);
					},
				)
				.finally(() => {
					refresh();
					context.requestRender();
				});
		};
		const row = (setting: SettingRow): SettingItem => {
			// A provider that reports nothing has no server column: the page's intro says so once.
			const reported =
				server === "reading" ? t("reading…") : server ? (setting.server ?? t("not reported")) : undefined;
			return {
				id: setting.key,
				label: setting.label,
				description: [reported === undefined ? "" : `${t("Server")}: ${reported}.`, t(ROW_HELP[setting.key])]
					.filter(Boolean)
					.join(" "),
				currentValue: `${setting.prism}${setting.corrected ? " ✎" : ""}`,
				...paged((_current, close) => ({
					kind: "input",
					input: {
						title: setting.label,
						description: `${t("new value for Prism")} (${t("empty: remove your correction")})`,
						current: setting.prism,
						parse: (text) => {
							const value = parseSettingValue(setting.key, text);
							return value instanceof Error ? value : text;
						},
						save: async (text) => {
							const value = text === undefined ? undefined : parseSettingValue(setting.key, text);
							if (value instanceof Error) throw value;
							const kind = server === "reading" ? undefined : server?.kind;
							reloaded(await saveSetting(deps, current, setting.key, value, kind));
						},
						requestRender: context.requestRender,
						done: () => close(),
					},
				})),
			};
		};
		const remove: SettingItem = {
			id: "remove",
			label: t("Remove my changes for this model"),
			description: "",
			currentValue: "",
			...paged((_current, close) => ({
				kind: "select",
				title: t("Remove my changes for this model"),
				description: "",
				options: [
					{ value: "remove", label: t("Remove") },
					{ value: "keep", label: t("Cancel") },
				],
				current: "keep",
				onSelect: async (value) => {
					if (value === "remove") {
						await clearModelCorrection(deps.modelsPath, current.provider, current.id);
						await saveSetting(deps, current, "tools", undefined, undefined);
						reloaded(undefined);
					}
					close();
				},
				onCancel: () => close(),
			})),
		};
		const removal = (id: "remove-model" | "remove-server", label: string): SettingItem => ({
			id,
			label,
			description: "",
			currentValue: "",
			...paged((_current, close) => ({
				kind: "select",
				title: label,
				description: "",
				options: [
					{ value: "remove", label: t("Remove") },
					{ value: "keep", label: t("Cancel") },
				],
				current: "keep",
				onSelect: async (value) => {
					if (value === "remove") {
						try {
							const server = id === "remove-server";
							const held = holdsDefault(context.defaultModel, current, server);
							message = await deps.remove!(current, server);
							removed = true;
							defaultChoices = held && context.defaultModel ? modelsLeft(deps, current, server) : [];
							if (defaultChoices.length > 0) message = `${message} ${t(DEFAULT_REMOVED)}`;
							else if (held) message = `${message} ${t(NO_DEFAULT_LEFT)}`;
						} catch (error) {
							message = error instanceof Error ? error.message : String(error);
						}
						refresh();
						context.requestRender();
					}
					close();
				},
				onCancel: () => close(),
			})),
		});
		/** fork: after removing the default, the one row left chooses another default. */
		const chooseDefault = (access: DefaultModelAccess): SettingItem => ({
			id: "choose-default-model",
			label: t("Choose another default model"),
			description: "",
			currentValue: "",
			...paged((_current, close) =>
				defaultChoicePage(defaultChoices, "", access, (chosen) => {
					if (chosen) {
						message = `${message ?? ""} ${chosen}`.trim();
						defaultChoices = [];
					}
					refresh();
					context.requestRender();
					close();
				}),
			),
		});
		// The window draws `items` and `description` again at each change: they are replaced in place.
		const refresh = () => {
			if (removed) {
				page.description = message ?? "";
				const access = context.defaultModel;
				page.items.splice(0, page.items.length);
				if (access && defaultChoices.length > 0) page.items.push(chooseDefault(access));
				return;
			}
			const rows = read();
			const shownRows = context.advanced() ? rows : rows.filter((setting) => !ADVANCED_ROWS.has(setting.key));
			page.description = [
				intro(server),
				context.advanced() ? "" : `… ${t("Advanced interface: sampling and the other request parameters")}`,
				message ?? "",
			]
				.filter(Boolean)
				.join("\n");
			const actions = pageActions(deps, current, rows).map((action): SettingItem => {
				if (action.id === "clear") return remove;
				if (action.id === "sync-server")
					return {
						id: action.id,
						label: action.label,
						description: "",
						currentValue: "update",
						values: ["update"],
					};
				return removal(action.id, action.label);
			});
			page.items.splice(0, page.items.length, ...shownRows.map(row), ...actions);
		};
		refresh();
		deps
			.readServer(model)
			.then(
				(values) => {
					server = values;
				},
				() => {
					server = undefined;
				},
			)
			.finally(() => {
				refresh();
				context.requestRender();
			});
		return page;
	};
}

/** The Models domain's section: one row per model, and in the search one row per setting of each model. */
export function modelPagesSection(deps: ModelPageDeps): SettingsSection {
	const models = () => {
		const list = deps.models();
		const current = deps.current();
		return current && !list.some((model) => modelKey(model) === modelKey(current)) ? [current, ...list] : list;
	};
	const page = (model: Model<Api>, context: SectionContext, focus?: RowKey): SettingItem["submenu"] => {
		return (_value, done) =>
			new ModelPage(deps, model, {
				focus,
				defaultModel: context.defaultModel,
				advanced: context.advanced,
				requestRender: context.requestRender,
				done: (value) => done(value),
			});
	};
	return {
		domain: "models",
		items: (context) => {
			const corrections = readAllCorrections(deps.modelsPath);
			const capabilities = readAllCapabilities(deps.capabilitiesFile);
			const current = deps.current();
			return models().map((model) => {
				const rows = settingRows(
					model,
					corrections(model.provider, model.id),
					undefined,
					capabilities[modelKey(model)],
				);
				const isCurrent = current !== undefined && modelKey(current) === modelKey(model);
				return {
					id: modelRowId(model),
					label: modelKey(model),
					description: t("Enter opens the model's page. /model-settings opens the current one."),
					currentValue: summary(isCurrent, changesOf(rows)),
					submenu: page(model, context),
					...withPage(modelSettingsPage(deps, model, context)),
				};
			});
		},
		searchItems: (context) => {
			const corrections = readAllCorrections(deps.modelsPath);
			const capabilities = readAllCapabilities(deps.capabilitiesFile);
			return models().flatMap((model) =>
				settingRows(model, corrections(model.provider, model.id), undefined, capabilities[modelKey(model)]).map(
					(row): SettingItem => ({
						id: `${modelRowId(model)}${ROW_SEPARATOR}${row.key}`,
						label: `${row.label} · ${modelKey(model)}`,
						description: ROW_HELP[row.key],
						currentValue: `${row.prism}${row.corrected ? " ✎" : ""}`,
						submenu: page(model, context, row.key),
						...withPage(modelSettingsPage(deps, model, context)),
					}),
				),
			);
		},
		// Each page saves its own values; the change only rebuilds the rows, so they show the new count.
		onChange: () => {},
		isAdvanced: (id) => {
			if (!id.startsWith(ROW_PREFIX)) return false;
			const key = id.slice(id.lastIndexOf(ROW_SEPARATOR) + 1);
			return id.includes(ROW_SEPARATOR) && ADVANCED_ROWS.has(key as RowKey);
		},
	};
}
