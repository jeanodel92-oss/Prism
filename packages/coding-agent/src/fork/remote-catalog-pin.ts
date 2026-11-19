/**
 * the pi.dev model catalog refreshes on its own again, but it may only add
 * or describe models: where Prism sends a provider's requests, and its key, stays what the built-in catalog says.
 * A compromised catalog could otherwise point a provider at another host. A remote model keeps its address only
 * when the built-in catalog has it for that provider; else it takes the address of the same built-in model, or of a
 * built-in model of the same API; a model with none of these is left out.
 */
import type { AnyModel } from "@earendil-works/pi-ai";

const baseUrlOf = (model: AnyModel): string | undefined =>
	"baseUrl" in model && typeof model.baseUrl === "string" ? model.baseUrl : undefined;
const apiOf = (model: AnyModel): string | undefined =>
	"api" in model && typeof model.api === "string" ? model.api : undefined;

/** The remote models, each with an address the built-in catalog gives this provider. */
export function pinRemoteBaseUrls(builtIn: readonly AnyModel[], remote: readonly AnyModel[]): AnyModel[] {
	const known = new Set(builtIn.map(baseUrlOf).filter((url): url is string => url !== undefined));
	return remote.flatMap((model) => {
		const url = baseUrlOf(model);
		if (url === undefined || known.has(url)) return [model];
		const same = builtIn.find((entry) => entry.id === model.id);
		const pinned =
			(same && baseUrlOf(same)) ??
			builtIn.map((entry) => (apiOf(entry) === apiOf(model) ? baseUrlOf(entry) : undefined)).find(Boolean);
		return pinned && known.has(pinned) ? [{ ...model, baseUrl: pinned } as AnyModel] : [];
	});
}
