// fork: the weekly catalog refresh failed to build when a test named a model its provider had
// retired. A test about one model looks it up here and is skipped once that model has left the catalog.
import { getModels } from "../src/compat.ts";
import type { Api, KnownProvider, Model } from "../src/types.ts";

/** The catalog's model `id` of `provider`, or undefined once it has left the catalog. */
export function catalogModel<TApi extends Api = Api>(provider: KnownProvider, id: string): Model<TApi> | undefined {
	return getModels(provider).find((model) => model.id === id) as Model<TApi> | undefined;
}
