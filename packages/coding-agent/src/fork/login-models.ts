/**
 * fork: after a login, a checklist of the provider's models, so a key that unlocks dozens of
 * models (42 with an OpenAI key, among them GPT-4 and o1) does not flood /model. Recent models are
 * checked: not deprecated, and released at most RECENT_MONTHS before the provider's newest model,
 * using the release date and status that the generated catalog keeps from models.dev
 * . A model without a date stays checked: nothing says it is old. The choice is saved as
 * `enabledModels`, the list `/scoped-models` edits, and applies to the session right away. Escape
 * keeps every model, as before. Nothing is asked when every model would be checked anyway. Either way, a
 * list that names none of the provider's models gets `provider/**`, so a provider added after another
 * login narrowed the list does not stay hidden from /model. A server added again with new models
 * gets those models added to a list that names only its old ones.
 */
import type { Model } from "@earendil-works/pi-ai";
import {
	type Component,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { resolveModelScopeFromModels, type ScopedModel } from "../core/model-resolver.ts";
import { theme } from "../modes/interactive/theme/theme.ts";
import { fill, t } from "./i18n/index.ts";

const RECENT_MONTHS = 6;

/**
 * Every model of a provider. `**`, not `*`: a glob `*` stops at "/", and model IDs often hold one (a local
 * server's `unsloth/Qwen3-27B-GGUF`, OpenRouter's `anthropic/claude-sonnet-4.5`), so `provider/*` matched none of
 * them.
 */
function wholeProvider(providerId: string): string {
	return `${providerId}/**`;
}
const MAX_VISIBLE = 10;

/** Newest first; models without a date first, in catalog order. */
function byRelease(models: readonly Model<any>[]): Model<any>[] {
	return [...models].sort((a, b) => (b.releaseDate ?? "9999").localeCompare(a.releaseDate ?? "9999"));
}

/** The IDs to check: recent and not deprecated, plus `keep` (the current and default models). */
export function recentModelIds(models: readonly Model<any>[], keep: readonly string[] = []): string[] {
	const newest = models.reduce<string | undefined>(
		(latest, model) => (model.releaseDate && (!latest || model.releaseDate > latest) ? model.releaseDate : latest),
		undefined,
	);
	let cutoff = "";
	if (newest) {
		const date = new Date(`${newest.length === 7 ? `${newest}-01` : newest}T00:00:00Z`);
		date.setUTCMonth(date.getUTCMonth() - RECENT_MONTHS);
		cutoff = date.toISOString().slice(0, 10);
	}
	return byRelease(models)
		.filter(
			(model) =>
				keep.includes(model.id) || (!model.deprecated && (!model.releaseDate || model.releaseDate >= cutoff)),
		)
		.map((model) => model.id);
}

/**
 * `enabledModels` once `providerId` is narrowed to `chosen`: the patterns naming that provider's
 * models are replaced. With no list yet (every model on), the other providers keep all their
 * models through a `provider/**` pattern each.
 */
export function scopeAfterLogin(
	patterns: readonly string[] | undefined,
	providerId: string,
	chosen: readonly string[],
	available: readonly Model<any>[],
): string[] {
	const kept = patterns
		? patterns.filter((pattern) => !pattern.toLowerCase().startsWith(`${providerId.toLowerCase()}/`))
		: [...new Set(available.map((model) => model.provider))]
				.filter((provider) => provider !== providerId)
				.map(wholeProvider);
	return [...kept, ...chosen.map((id) => `${providerId}/${id}`)];
}

export interface LoginModelsOptions {
	providerName: string;
	models: readonly Model<any>[];
	checked: readonly string[];
	onSave: (ids: string[]) => void;
	onCancel: () => void;
}

/** The checklist: a "Save" row, then the models, newest first. Enter checks or saves; escape keeps all. */
export class LoginModelsChecklist implements Component {
	private readonly options: LoginModelsOptions;
	private readonly models: Model<any>[];
	private readonly checked: Set<string>;
	private cursor = 0;

	constructor(options: LoginModelsOptions) {
		this.options = options;
		this.models = byRelease(options.models);
		this.checked = new Set(options.checked);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const wrapped = (text: string) => wrapTextWithAnsi(text, Math.max(1, width - 2)).map((line) => ` ${line}`);
		const clip = (row: string) => (visibleWidth(row) <= width ? row : truncateToWidth(row, width, "…"));
		const lines = [
			"",
			...wrapped(theme.bold(theme.fg("accent", fill("Models from {0}", this.options.providerName)))),
			...wrapped(
				theme.fg(
					"muted",
					t("Checked models appear in /model; recent ones are checked. Change this later with /scoped-models."),
				),
			),
			"",
		];
		const count = fill("{0} of {1} models", String(this.checked.size), String(this.models.length));
		const rows = [`${t("Save")} (${count})`, ...this.models.map((model) => this.modelRow(model))];
		const start = Math.max(0, Math.min(this.cursor - Math.floor(MAX_VISIBLE / 2), rows.length - MAX_VISIBLE));
		const end = Math.min(rows.length, start + MAX_VISIBLE);
		for (let i = start; i < end; i++) {
			const here = i === this.cursor;
			lines.push(clip(` ${here ? theme.fg("accent", "→ ") : "  "}${here ? theme.fg("accent", rows[i]!) : rows[i]}`));
		}
		if (start > 0 || end < rows.length) lines.push(theme.fg("dim", `   (${this.cursor + 1}/${rows.length})`));
		lines.push("");
		lines.push(...wrapped(theme.fg("dim", `↑↓ · ${t("enter: check or save")} · ${t("esc: keep all")}`)));
		return lines;
	}

	private modelRow(model: Model<any>): string {
		const mark = this.checked.has(model.id) ? "[x] " : "[ ] ";
		const details = [model.releaseDate, model.deprecated ? t("deprecated") : undefined].filter(Boolean).join(" · ");
		return `${mark}${model.id}${details ? theme.fg("dim", `  ${details}`) : ""}`;
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		const last = this.models.length;
		if (keys.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
			return;
		}
		if (keys.matches(data, "tui.select.up")) this.cursor = this.cursor === 0 ? last : this.cursor - 1;
		else if (keys.matches(data, "tui.select.down")) this.cursor = this.cursor === last ? 0 : this.cursor + 1;
		else if (keys.matches(data, "tui.select.confirm")) {
			if (this.cursor === 0) {
				this.options.onSave(this.models.filter((model) => this.checked.has(model.id)).map((model) => model.id));
				return;
			}
			const id = this.models[this.cursor - 1]!.id;
			if (this.checked.has(id)) this.checked.delete(id);
			else this.checked.add(id);
		}
	}
}

/** What the checklist changes: the session's `enabledModels` and the models Ctrl+P cycles through. */
export interface LoginModelsScope {
	providerId: string;
	available: readonly Model<any>[];
	patterns: string[] | undefined;
	/** Model IDs of this provider to keep checked: the current and the default one. */
	keep: readonly string[];
	/** A server added again: the model IDs it lists now and did not before, to add to a list that misses them. */
	added?: readonly string[];
	savePatterns: (patterns: string[]) => void;
	setScopedModels: (models: ScopedModel[]) => void;
}

/** The checklist to show, for the terminal and the Prism window (login-native.ts) alike. */
export interface LoginModelsChoice {
	/** The provider's models, newest first. */
	models: Model<any>[];
	checked: string[];
	/** Saves the checked models as the provider's. */
	save: (ids: readonly string[]) => void;
	/** Escape: every model of the provider stays offered. */
	keepAll: () => void;
}

/** The checklist, or `undefined` when every model would be checked anyway (then nothing narrows the provider). */
export function loginModelsChoice(scope: LoginModelsScope): LoginModelsChoice | undefined {
	const models = scope.available.filter((model) => model.provider === scope.providerId);
	const apply = (patterns: string[]) => {
		scope.savePatterns(patterns);
		scope.setScopedModels(resolveModelScopeFromModels(patterns, [...scope.available]).scopedModels);
	};
	const keepAll = () => {
		const patterns = scope.patterns;
		if (!patterns) return;
		const scoped = resolveModelScopeFromModels(patterns, [...scope.available])
			.scopedModels.filter((entry) => entry.model.provider === scope.providerId)
			.map((entry) => entry.model.id);
		if (scoped.length === 0) {
			apply([...patterns, wholeProvider(scope.providerId)]);
			return;
		}
		const missing = (scope.added ?? []).filter((id) => !scoped.includes(id));
		if (missing.length > 0) apply([...patterns, ...missing.map((id) => `${scope.providerId}/${id}`)]);
	};
	const checked = recentModelIds(models, scope.keep);
	if (checked.length === models.length) {
		keepAll();
		return undefined;
	}
	return {
		models: byRelease(models),
		checked,
		save: (ids) => apply(scopeAfterLogin(scope.patterns, scope.providerId, ids, scope.available)),
		keepAll,
	};
}

export interface LoginModelsHost extends LoginModelsScope {
	providerName: string;
	show: (create: (done: () => void) => Component) => void;
	requestRender: () => void;
}

/** Offer the checklist when the provider has models that would not be checked. */
export function offerLoginModels(host: LoginModelsHost): boolean {
	const choice = loginModelsChoice(host);
	if (!choice) return false;
	host.show(
		(done) =>
			new LoginModelsChecklist({
				providerName: host.providerName,
				models: choice.models,
				checked: choice.checked,
				onSave: (ids) => {
					done();
					choice.save(ids);
					host.requestRender();
				},
				onCancel: () => {
					done();
					choice.keepAll();
					host.requestRender();
				},
			}),
	);
	return true;
}
