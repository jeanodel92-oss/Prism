/**
 * fork: a saved default model that is gone (removed from /settings, or its server
 * removed from models.json) or has no key made every start open new conversations on another model, without a
 * word. The model chosen stays the same; this says once, at start, which one is used instead and where to choose.
 * The startup paths (main.ts with `enabledModels`, `findInitialModel` without) pass it as the session's
 * `modelFallbackMessage`, which the terminal shows as a warning and the RPC mode sends to the window as a notice.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../core/model-runtime.ts";
import { fill } from "./i18n/index.ts";

/**
 * The notice when the saved default (`defaultProvider`/`defaultModelId`) cannot be used and `used` opens instead;
 * undefined when no default is saved, when `used` is the default, when no model opens (another message says so),
 * or when the default exists with a key but another model was chosen on purpose (`--model`, `--models`). Outside
 * `enabledModels` such a default still opens: that setting narrows the cycle, not the default.
 */
export function defaultModelFallbackMessage(
	modelRuntime: Pick<ModelRuntime, "getModel" | "hasConfiguredAuth">,
	defaultProvider: string | undefined,
	defaultModelId: string | undefined,
	used: Model<Api> | undefined,
): string | undefined {
	if (!defaultProvider || !defaultModelId || !used) return undefined;
	if (used.provider === defaultProvider && used.id === defaultModelId) return undefined;
	const saved = `${defaultProvider}/${defaultModelId}`;
	const usedKey = `${used.provider}/${used.id}`;
	const found = modelRuntime.getModel(defaultProvider, defaultModelId);
	if (!found)
		return fill("Default model {0} not found; using {1}. Choose another in /settings › Models.", saved, usedKey);
	if (!modelRuntime.hasConfiguredAuth(found.provider))
		return fill(
			"No key for the default model {0}; using {1}. Sign in with /login, or choose another default in /settings › Models.",
			saved,
			usedKey,
		);
	return undefined;
}
