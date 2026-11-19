// a built-in model a fresh pi.dev catalog no longer lists leaves /model,
// except the default model and the models models.json names; without a fresh catalog nothing is hidden.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createProvider,
	InMemoryModelsStore,
	type Model,
	type ModelsPublication,
	type Provider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";
import { keptModelIds } from "../src/fork/hide-retired-models.ts";

const BASE_URL = "https://api.example.test/v1";

function model(id: string) {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<"openai-completions">;
}

function provider(kept: ReadonlySet<string> = new Set()): Provider {
	return withRemoteCatalog(
		createProvider({
			id: "test-provider",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model("current"), model("retired"), model("pinned")],
			api: {
				stream: () => {
					throw new Error("not used");
				},
				streamSimple: () => {
					throw new Error("not used");
				},
			},
		}),
		"https://pi.dev",
		undefined,
		true,
		() => kept,
	);
}

async function refresh(remote: Provider, response: Response): Promise<string[]> {
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => response);
	const store = new InMemoryModelsStore();
	const publish = async (publication: ModelsPublication) => {
		if (publication.persist) await store.write(remote.id, publication.persist);
		publication.update?.();
		return true;
	};
	await remote
		.refreshModels?.({
			credential: { type: "api_key" },
			stored: undefined,
			publish,
			allowNetwork: true,
			signal: new AbortController().signal,
		})
		.catch(() => undefined);
	return remote
		.getModels()
		.map((entry) => entry.id)
		.sort();
}

let agentDir: string | undefined;
const previousAgentDir = process.env[ENV_AGENT_DIR];
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "prism-retired-models-"));
	process.env[ENV_AGENT_DIR] = agentDir;
});
afterEach(() => {
	vi.restoreAllMocks();
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	if (agentDir) rmSync(agentDir, { recursive: true, force: true });
});

describe("fork: models a fresh catalog retired", () => {
	it("hides a built-in model the catalog no longer lists, and adds the new ones", async () => {
		const ids = await refresh(provider(), Response.json({ models: [model("current"), model("new")] }));
		expect(ids).toEqual(["current", "new"]);
	});

	it("keeps the models it is told to keep", async () => {
		const ids = await refresh(provider(new Set(["pinned"])), Response.json({ models: [model("current")] }));
		expect(ids).toEqual(["current", "pinned"]);
	});

	it("hides nothing without a catalog", async () => {
		const ids = await refresh(provider(), new Response("down", { status: 503 }));
		expect(ids).toEqual(["current", "pinned", "retired"]);
	});

	it("hides nothing when the catalog is older than the built-in snapshot", async () => {
		const remote = withRemoteCatalog(
			createProvider({
				id: "test-provider",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [model("current"), model("retired")],
				api: {
					stream: () => {
						throw new Error("not used");
					},
					streamSimple: () => {
						throw new Error("not used");
					},
				},
			}),
			"https://pi.dev",
			Date.parse("2026-11-14T00:00:00Z"),
			true,
			() => new Set(),
		);
		const response = Response.json(
			{ models: [model("current")] },
			{ headers: { "last-modified": "Fri, 13 Nov 2026 13:56:27 GMT" } },
		);
		expect(await refresh(remote, response)).toEqual(["current", "retired"]);
	});

	it("keeps the default model and the models models.json names", () => {
		writeFileSync(
			join(process.env[ENV_AGENT_DIR] ?? "", "settings.json"),
			JSON.stringify({ defaultProvider: "test-provider", defaultModel: "chosen" }),
		);
		const kept = keptModelIds("test-provider", {
			modelOverrides: { overridden: { name: "Overridden" } },
			models: [{ id: "custom" }],
		} as Parameters<typeof keptModelIds>[1]);
		expect([...kept].sort()).toEqual(["chosen", "custom", "overridden"]);
		expect([...keptModelIds("other-provider", undefined)]).toEqual([]);
	});
});
