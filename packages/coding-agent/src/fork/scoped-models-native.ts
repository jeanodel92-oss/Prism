// `/scoped-models` as native screens of the Prism window. The same choices as the terminal's
// ScopedModelsSelectorComponent: each model on or off, all, none, a provider's models, their order, and Save; each
// change applies to the session at once, Save keeps it in the settings. The reads and writes are the terminal's
// (scoped-models-operations.ts), the list changes its selector's.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "../core/extensions/types.ts";
import {
	clearAll,
	type EnabledIds,
	enableAll,
	getSortedIds,
	isEnabled,
	move,
	toggle,
} from "../modes/interactive/components/scoped-models-selector.ts";
import { fill, t } from "./i18n/index.ts";
import { type NativeAction, NativeFlow, showNativeFlow } from "./native-flow.ts";
import type { ScopedModelsOperations } from "./scoped-models-operations.ts";

export class NativeScopedModelsView extends NativeFlow {
	private readonly operations: ScopedModelsOperations;
	private readonly saved: () => void;
	private models = new Map<string, Model<Api>>();
	private allIds: string[] = [];
	private enabledIds: EnabledIds;
	private dirty = false;
	private status = "Refreshing model catalogs…";
	private shown: "list" | "order" = "list";

	constructor(changed: () => void, operations: ScopedModelsOperations, saved: () => void) {
		super(changed, { screenId: "loading", kind: "detail", title: t("Model Configuration"), busy: true });
		this.operations = operations;
		this.saved = saved;
		this.enabledIds = operations.enabledIds();
		this.readModels();
	}

	/** Until Close, or the panel closes. */
	run(): Promise<void> {
		return this.wait<void>((finish) => {
			const refresh = this.operations.refresh();
			void refresh.done.then((result) => {
				if (this.closed) return;
				this.readModels();
				if (result.reset) this.enabledIds = this.operations.enabledIds();
				this.status = result.status;
				this.render(() => finish(undefined));
			});
			this.render(() => finish(undefined));
			return () => refresh.abort();
		});
	}

	private readModels(): void {
		this.models = new Map(this.operations.models().map((model) => [`${model.provider}/${model.id}`, model]));
		this.allIds = [...this.models.keys()];
	}

	private change(enabledIds: EnabledIds): void {
		this.enabledIds = enabledIds;
		this.dirty = true;
		this.operations.change(enabledIds === null ? null : [...enabledIds]);
	}

	private count(): string {
		const ids = this.enabledIds;
		if (ids === null) return t("all enabled");
		const unavailable = ids.filter((id) => !this.models.has(id)).length;
		return (
			fill("{0}/{1} enabled", String(ids.length - unavailable), String(this.allIds.length)) +
			(unavailable ? fill(" · {0} unavailable", String(unavailable)) : "")
		);
	}

	private render(finish: () => void): void {
		if (this.shown === "order") this.showOrder(finish);
		else this.showList(finish);
	}

	private showList(finish: () => void): void {
		const prefix = "list:";
		const providers = [...new Set([...this.models.values()].map((model) => model.provider))];
		const ids = getSortedIds(this.enabledIds, this.allIds);
		this.show(
			{
				screenId: "scoped-models",
				kind: "multiSelect",
				title: t("Model Configuration"),
				lines: [
					t(
						"Checked models are the ones Ctrl+P cycles through, in this order. Each change applies to this session; Save keeps it.",
					),
					t(this.status),
					`${this.count()}${this.dirty ? ` ${t("(unsaved)")}` : ""}`,
				],
				hint: "close",
				enableSearch: ids.length > 6,
				items: ids.map((id) => {
					const model = this.models.get(id);
					return {
						id: `${prefix}model:${id}`,
						label: model ? model.id : `${id}${t(" [unavailable]")}`,
						description: model ? `${model.provider} · ${model.name}` : t("  Model unavailable").trim(),
						searchText: id,
						selected: model !== undefined && isEnabled(this.enabledIds, id),
					};
				}),
				actions: [
					{ id: `${prefix}all`, label: t("Enable all") },
					{ id: `${prefix}none`, label: t("Clear all") },
					...(providers.length > 1
						? providers.map((provider) => ({
								id: `${prefix}provider:${provider}`,
								label: fill("All of {0} on or off", provider),
							}))
						: []),
					...(this.enabledIds !== null && this.enabledIds.length > 1
						? [{ id: `${prefix}order`, label: t("Change the order") }]
						: []),
					{ id: `${prefix}save`, label: t("Save to settings") },
				],
			},
			(action) => this.handleList(action, prefix, finish),
		);
	}

	private handleList(action: NativeAction, prefix: string, finish: () => void): boolean {
		if (action.kind === "back") {
			finish();
			return true;
		}
		const id =
			typeof action.itemId === "string" && action.itemId.startsWith(prefix)
				? action.itemId.slice(prefix.length)
				: "";
		if (action.kind === "multiSelect" && id.startsWith("model:")) {
			const model = id.slice("model:".length);
			if (!getSortedIds(this.enabledIds, this.allIds).includes(model) || typeof action.selected !== "boolean")
				return false;
			// A box shows the state it asks for: a second click on its way does not toggle it back.
			if (action.selected !== (this.models.has(model) && isEnabled(this.enabledIds, model)))
				this.change(toggle(this.enabledIds, this.allIds, model));
		} else if (action.kind !== "activate") return false;
		else if (id === "all") this.change(enableAll(this.enabledIds, this.allIds));
		else if (id === "none") this.change(clearAll(this.enabledIds, this.allIds));
		else if (id.startsWith("provider:")) {
			const provider = id.slice("provider:".length);
			const providerIds = this.allIds.filter((modelId) => this.models.get(modelId)?.provider === provider);
			if (providerIds.length === 0) return false;
			const allEnabled = providerIds.every((modelId) => isEnabled(this.enabledIds, modelId));
			this.change(
				allEnabled
					? clearAll(this.enabledIds, this.allIds, providerIds)
					: enableAll(this.enabledIds, this.allIds, providerIds),
			);
		} else if (id === "order" && this.enabledIds !== null && this.enabledIds.length > 1) this.shown = "order";
		else if (id === "save") {
			this.operations.persist(this.enabledIds === null ? null : [...this.enabledIds]);
			this.dirty = false;
			this.saved();
		} else return false;
		this.render(finish);
		return true;
	}

	/** The enabled models in Ctrl+P order, each with its place. */
	private showOrder(finish: () => void): void {
		const prefix = "order:";
		const order = this.enabledIds ?? [];
		const places = order.map((_, index) => String(index + 1));
		this.show(
			{
				screenId: "scoped-models:order",
				kind: "settings",
				title: t("Change the order"),
				lines: [t("The order Ctrl+P cycles through the checked models.")],
				items: order.map((id, index) => ({
					id: `${prefix}${id}`,
					label: this.models.get(id)?.id ?? id,
					description: this.models.get(id)?.provider ?? t("  Model unavailable").trim(),
					currentValue: String(index + 1),
					values: places,
				})),
			},
			(action) => {
				if (action.kind === "back") {
					this.shown = "list";
					this.render(finish);
					return true;
				}
				const id =
					typeof action.itemId === "string" && action.itemId.startsWith(prefix)
						? action.itemId.slice(prefix.length)
						: "";
				const from = order.indexOf(id);
				const to = places.indexOf(String(action.value));
				if (action.kind !== "setting" || from === -1 || to === -1) return false;
				let next: EnabledIds = order;
				for (let at = from; at !== to; at += to > from ? 1 : -1) next = move(next, id, to > from ? 1 : -1);
				if (next !== order) this.change(next);
				this.render(finish);
				return true;
			},
		);
	}
}

/** `/scoped-models` in one native panel until it is closed. */
export function showNativeScopedModels(
	ctx: ExtensionContext,
	operations: ScopedModelsOperations,
	saved: () => void,
): Promise<void> {
	return showNativeFlow<NativeScopedModelsView>(
		ctx,
		(changed) => new NativeScopedModelsView(changed, operations, saved),
		(view) => view.run(),
	);
}
