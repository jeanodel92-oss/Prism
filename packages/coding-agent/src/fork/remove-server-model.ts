/**
 * a model or a whole server the user added can be removed again. A local server that
 * changed models (Qwen 3.8 27B to Qwen 3.8 Flash Next) kept the old model listed for good; a server added a
 * second time under a wrong name stayed too. Only what models.json lists is removed (the servers `/login` adds, or
 * the user wrote): the built-in catalog is not edited. The /settings page of such a model offers both.
 */
import { existsSync, readFileSync } from "node:fs";
import { lockForkFile } from "./file-lock.ts";
import { fill } from "./i18n/index.ts";
import { writeFileAtomicSync } from "./secrets/atomic-write.ts";

type Json = Record<string, unknown>;

const record = (value: unknown): Json | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;

function readProviders(modelsPath: string): Json | undefined {
	if (!existsSync(modelsPath)) return undefined;
	try {
		return record(record(JSON.parse(readFileSync(modelsPath, "utf-8")))?.providers);
	} catch {
		return undefined;
	}
}

const modelIds = (provider: Json | undefined): string[] | undefined => {
	const models = provider?.models;
	if (!Array.isArray(models)) return undefined;
	return models.flatMap((model) => {
		const id = record(model)?.id;
		return typeof id === "string" ? [id] : [];
	});
};

/** The models models.json lists for `provider`, or undefined when it lists none (a built-in provider). */
export function serverModelIds(modelsPath: string, provider: string): string[] | undefined {
	return modelIds(record(readProviders(modelsPath)?.[provider]));
}

/** Applies `edit` to models.json's providers under the file lock; a file that is not plain JSON is refused. */
function editProviders(modelsPath: string, edit: (providers: Json) => void): Promise<void> {
	return lockForkFile(modelsPath, () => {
		let config: Json;
		try {
			config = record(JSON.parse(readFileSync(modelsPath, "utf-8"))) ?? {};
		} catch {
			throw new Error(
				fill(
					"Could not update {0}: it must contain valid JSON (a structured settings format, without comments). Check the file, then retry.",
					modelsPath,
				),
			);
		}
		const providers = record(config.providers) ?? {};
		edit(providers);
		config.providers = providers;
		// fork: synced, and refused once the lock may be another writer's.
		writeFileAtomicSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`);
	});
}

/**
 * Removes one model from its server in models.json, with its corrections. The server's last model removes the
 * server too: a server without models offers nothing. Resolves to whether the server was removed.
 */
export async function removeServerModel(modelsPath: string, provider: string, modelId: string): Promise<boolean> {
	let serverRemoved = false;
	await editProviders(modelsPath, (providers) => {
		const entry = record(providers[provider]);
		const models = entry?.models;
		if (!entry || !Array.isArray(models)) return;
		entry.models = models.filter((model) => record(model)?.id !== modelId);
		const overrides = record(entry.modelOverrides);
		if (overrides) {
			delete overrides[modelId];
			if (Object.keys(overrides).length === 0) delete entry.modelOverrides;
		}
		if ((entry.models as unknown[]).length === 0) {
			delete providers[provider];
			serverRemoved = true;
		}
	});
	return serverRemoved;
}

/** Removes the server and all its models from models.json. */
export function removeServer(modelsPath: string, provider: string): Promise<void> {
	return editProviders(modelsPath, (providers) => {
		delete providers[provider];
	});
}
