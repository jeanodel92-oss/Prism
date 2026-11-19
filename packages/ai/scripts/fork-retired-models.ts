// fork: the weekly catalog refresh broke whenever a provider retired a model that a test or the
// code names by its ID (`getModel("fireworks", "accounts/fireworks/models/...")` stops type-checking). A chat model
// that left its provider's live catalog is carried over from the previous snapshot, marked deprecated, as long as
// the packages' sources or tests still name it. Models nothing names are dropped, so the catalog does not grow forever.
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { Api, Model } from "../src/types.ts";

/** A provider's data file: `{ [api]: { ["chat:<id>" | "image:<id>" | ...]: model } }`. */
type ProviderData = Record<string, Record<string, { type?: string } & Model<Api>>>;

/** Every string literal of `source`, and every name read as a property (`MODELS.acme.plain`). */
function namesIn(source: string): Set<string> {
	const found = new Set<string>();
	for (const m of source.matchAll(/"([^"\\\n]{1,200})"|'([^'\\\n]{1,200})'|`([^`\\\n$]{1,200})`|\.([A-Za-z_$][\w$]*)/g)) {
		found.add(m[1] ?? m[2] ?? m[3] ?? m[4]);
	}
	return found;
}

/**
 * Adds to `chat` (provider -> id -> model) each chat model of `previous` (provider -> data file) that is missing
 * from `chat` and named in `source`, marked deprecated. Returns the carried-over models as `provider/id`.
 */
export function keepRetiredModels(
	chat: Record<string, Record<string, Model<Api>>>,
	previous: Record<string, ProviderData>,
	source: string,
): string[] {
	const named = namesIn(source);
	const kept: string[] = [];
	for (const [provider, byApi] of Object.entries(previous)) {
		for (const models of Object.values(byApi)) {
			for (const [identity, model] of Object.entries(models)) {
				if (!identity.startsWith("chat:") || chat[provider]?.[model.id] || !named.has(model.id)) continue;
				chat[provider] ??= {};
				chat[provider][model.id] = { ...model, deprecated: true };
				kept.push(`${provider}/${model.id}`);
			}
		}
	}
	return kept.sort();
}

/** The previous snapshot's data files, keyed by provider. */
export function readPreviousSnapshot(packageRoot: string): Record<string, ProviderData> {
	const dataDir = join(packageRoot, "src", "providers", "data");
	if (!existsSync(dataDir)) return {};
	const previous: Record<string, ProviderData> = {};
	for (const entry of readdirSync(dataDir)) {
		if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
		previous[entry.slice(0, -".json".length)] = JSON.parse(readFileSync(join(dataDir, entry), "utf8"));
	}
	return previous;
}

/** The TypeScript sources and tests of every package, generated catalog files excluded. */
export function readPackageSources(packagesDir: string): string {
	const parts: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== "data") walk(path);
			} else if (/\.(ts|tsx|mts)$/.test(entry.name) && !/\.models\.ts$|models\.generated\.ts$/.test(entry.name)) {
				parts.push(readFileSync(path, "utf8"));
			}
		}
	};
	for (const pkg of readdirSync(packagesDir)) {
		for (const sub of ["src", "test"]) {
			const dir = join(packagesDir, pkg, sub);
			if (existsSync(dir)) walk(dir);
		}
	}
	return parts.join("\n");
}
