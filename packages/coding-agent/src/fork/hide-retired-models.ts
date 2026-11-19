/**
 * a model the provider retired leaves /model on its own. Once a fresh pi.dev
 * catalog for a provider is in, a built-in model it no longer lists is hidden: the built-in snapshot only changes
 * with a Prism release, so without this a retired model would stay offered until the next one.
 *
 * Kept anyway: the default model in the global settings and every model models.json names for the provider
 * (`models`, `modelOverrides`), so a user's choice never disappears under them. A model of a type the catalog
 * returned none of is kept too, since an older catalog server answers with chat models only. Without a fresh
 * catalog (offline, refresh turned off, 404, or a snapshot newer than the catalog) nothing is hidden.
 */
import { type AnyModel, getModelType } from "@earendil-works/pi-ai";
import type { ModelsJsonProvider } from "../core/model-config.ts";
import { readGlobalSetting } from "./global-settings.ts";

const keyOf = (model: AnyModel): string => `${getModelType(model)}\0${model.id}`;

/** The model ids of `providerId` that stay listed whatever the catalog says. */
export function keptModelIds(providerId: string, config: ModelsJsonProvider | undefined): Set<string> {
	const kept = new Set<string>([
		...Object.keys(config?.modelOverrides ?? {}),
		...(config?.models ?? []).map((model) => model.id),
	]);
	const defaultModel = readGlobalSetting("defaultModel");
	if (readGlobalSetting("defaultProvider") === providerId && typeof defaultModel === "string") {
		kept.add(defaultModel);
	}
	return kept;
}

/** The keys (type and id) of the built-in models a fresh `remote` catalog retired; empty when there is none. */
export function retiredModelKeys(
	builtIn: readonly AnyModel[],
	remote: readonly AnyModel[],
	kept: ReadonlySet<string>,
): Set<string> {
	if (remote.length === 0) return new Set();
	const listed = new Set(remote.map(keyOf));
	const types = new Set(remote.map(getModelType));
	return new Set(
		builtIn
			.filter((model) => types.has(getModelType(model)) && !listed.has(keyOf(model)) && !kept.has(model.id))
			.map(keyOf),
	);
}

/** `models` without the retired ones. */
export function withoutRetired<TModel extends AnyModel>(models: readonly TModel[], retired: ReadonlySet<string>) {
	return retired.size === 0 ? models : models.filter((model) => !retired.has(keyOf(model)));
}
