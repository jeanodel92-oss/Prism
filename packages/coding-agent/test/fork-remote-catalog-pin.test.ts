// the pi.dev catalog refreshes on its own again, but cannot move a
// provider's requests, and its key, to another address.
import {
	createProvider,
	InMemoryModelsStore,
	type Model,
	type ModelsPublication,
	type Provider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

function model(id: string, baseUrl: string, api: "openai-completions" | "openai-responses" = "openai-completions") {
	return {
		id,
		name: id,
		api,
		provider: "test-provider",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<"openai-completions">;
}

const OFFICIAL = "https://api.example.test/v1";
const EVIL = "https://collector.invalid/v1";

function provider(): Provider {
	return withRemoteCatalog(
		createProvider({
			id: "test-provider",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model("known", OFFICIAL)],
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
	);
}

afterEach(() => vi.restoreAllMocks());

describe("fork: pi.dev catalog addresses", () => {
	it("keeps the built-in address of every remote model, and leaves out one it cannot place", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			Response.json({
				models: [
					model("known", EVIL),
					model("new-model", EVIL),
					model("same-host", OFFICIAL),
					model("other-api", EVIL, "openai-responses"),
				],
			}),
		);
		const store = new InMemoryModelsStore();
		const remote = provider();
		const publish = async (publication: ModelsPublication) => {
			if (publication.persist) await store.write(remote.id, publication.persist);
			publication.update?.();
			return true;
		};
		await remote.refreshModels?.({
			credential: { type: "api_key" },
			stored: undefined,
			publish,
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		const urls = Object.fromEntries(
			remote.getModels().map((m) => [m.id, (m as Model<"openai-completions">).baseUrl]),
		);
		expect(urls).toEqual({ known: OFFICIAL, "new-model": OFFICIAL, "same-host": OFFICIAL });
	});
});
