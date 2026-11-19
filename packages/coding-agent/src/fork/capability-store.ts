/**
 * fork: what detection said about each model, kept so the harness can tell "absent"
 * from "unknown" later. models.json cannot say it: a text-only `input` is both "the server says no
 * images" and "nobody knows". Stored in `<agentDir>/capabilities.json`, keyed `provider/model`.
 *
 * Tool calls have no model field in pi, so the user's own choice for them lives here too.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tri } from "./capabilities.ts";
import { lockForkFile } from "./file-lock.ts";
import { writeFileAtomicSync } from "./secrets/atomic-write.ts";

export interface StoredCapabilities {
	vision: Tri;
	tools: Tri;
	reasoning: Tri;
	/** The user's choice for tool calls (/model-settings); wins over `tools`. */
	toolCalls?: boolean;
}

type Store = Record<string, StoredCapabilities>;

export function capabilitiesPath(agentDir: string): string {
	return join(agentDir, "capabilities.json");
}

function readStore(path: string): Store {
	try {
		return storeForUpdate(path);
	} catch {
		return {};
	}
}

/**
 * fork: the store a change starts from. Missing is empty; unreadable or invalid throws,
 * so the change leaves the file as it is instead of replacing it with the change alone.
 */
function storeForUpdate(path: string): Store {
	if (!existsSync(path)) return {};
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Store;
	throw new Error(`${path} is not a JSON object; fix or remove it. It was not changed.`);
}

function writeStore(path: string, store: Store): void {
	// fork: synced, and refused once the lock may be another writer's.
	writeFileAtomicSync(path, `${JSON.stringify(store, null, 2)}\n`);
}

/** fork: every model's entry, keyed `provider/model`, read once for a list of models. */
export function readAllCapabilities(path: string): Readonly<Record<string, StoredCapabilities>> {
	return readStore(path);
}

/** Undefined for a model detection never saw. */
export function readCapabilities(path: string, provider: string, modelId: string): StoredCapabilities | undefined {
	return readStore(path)[`${provider}/${modelId}`];
}

/** Records a new detection; the user's tool-call choice for the model is kept. */
export async function recordDetection(
	path: string,
	provider: string,
	models: ReadonlyArray<{ id: string; vision: Tri; tools: Tri; reasoning: Tri }>,
): Promise<void> {
	return lockForkFile(path, () => {
		const store = storeForUpdate(path);
		for (const { id, vision, tools, reasoning } of models) {
			const key = `${provider}/${id}`;
			const toolCalls = store[key]?.toolCalls;
			store[key] = { vision, tools, reasoning, ...(toolCalls !== undefined ? { toolCalls } : {}) };
		}
		writeStore(path, store);
	});
}

/** Sets (or, with undefined, removes) the user's tool-call choice for one model. */
export async function writeToolCalls(
	path: string,
	provider: string,
	modelId: string,
	value: boolean | undefined,
): Promise<void> {
	return lockForkFile(path, () => {
		const store = storeForUpdate(path);
		const key = `${provider}/${modelId}`;
		const entry: StoredCapabilities = store[key] ?? { vision: "unknown", tools: "unknown", reasoning: "unknown" };
		if (value === undefined) delete entry.toolCalls;
		else entry.toolCalls = value;
		store[key] = entry;
		writeStore(path, store);
	});
}
