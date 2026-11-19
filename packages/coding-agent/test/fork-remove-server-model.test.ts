// a model, or a whole server, the user added can be removed again from /settings.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncCompatibleServer } from "../src/fork/compatible-server.ts";
import { removeServer, removeServerModel, serverModelIds } from "../src/fork/remove-server-model.ts";
import { type ModelPageDeps, modelPagesSection } from "../src/fork/settings-model-page.ts";
import { pageOf } from "../src/fork/settings-pages.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function modelsFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "prism-remove-model-"));
	dirs.push(dir);
	const path = join(dir, "models.json");
	writeFileSync(
		path,
		JSON.stringify({
			providers: {
				home: {
					baseUrl: "http://192.168.1.10:8080/v1",
					api: "openai-completions",
					apiKey: "none",
					models: [{ id: "qwen-3.8-27b" }, { id: "qwen-3.8-flash-next" }],
					modelOverrides: { "qwen-3.8-27b": { name: "Old" } },
				},
				typo: { baseUrl: "http://192.168.1.10:8080/v1", api: "openai-completions", models: [{ id: "only" }] },
				anthropic: { modelOverrides: { "claude-opus-5": { contextWindow: 1000 } } },
			},
		}),
	);
	return path;
}

const providers = (path: string) => JSON.parse(readFileSync(path, "utf-8")).providers;

describe("fork: removing a model or a server from models.json", () => {
	it("lists only the models of a server models.json defines", () => {
		const path = modelsFile();
		expect(serverModelIds(path, "home")).toEqual(["qwen-3.8-27b", "qwen-3.8-flash-next"]);
		expect(serverModelIds(path, "anthropic")).toBeUndefined();
		expect(serverModelIds(path, "absent")).toBeUndefined();
	});

	it("removes one model and its corrections, and the server with its last model", async () => {
		const path = modelsFile();
		expect(await removeServerModel(path, "home", "qwen-3.8-27b")).toBe(false);
		expect(providers(path).home.models).toEqual([{ id: "qwen-3.8-flash-next" }]);
		expect(providers(path).home.modelOverrides).toBeUndefined();
		expect(await removeServerModel(path, "typo", "only")).toBe(true);
		expect(providers(path).typo).toBeUndefined();
		expect(providers(path).anthropic).toBeDefined();
	});

	it("removes a whole server, keeping the others", async () => {
		const path = modelsFile();
		await removeServer(path, "typo");
		expect(Object.keys(providers(path))).toEqual(["home", "anthropic"]);
	});

	it("offers the removals on the window page of a server's model only", async () => {
		const path = modelsFile();
		const model = (provider: string, id: string) =>
			({
				provider,
				id,
				name: id,
				contextWindow: 32000,
				maxTokens: 4096,
				input: ["text"],
				reasoning: false,
			}) as Model<Api>;
		const remove = vi.fn(async () => "Removed home/qwen-3.8-27b.");
		const deps: ModelPageDeps = {
			modelsPath: path,
			capabilitiesFile: join(path, "..", "capabilities.json"),
			models: () => [model("home", "qwen-3.8-27b"), model("anthropic", "claude-opus-5")],
			current: () => undefined,
			readServer: async () => undefined,
			reload: async (m) => m,
			serverModels: (m) => serverModelIds(path, m.provider),
			remove,
		};
		const section = modelPagesSection(deps);
		const context = { advanced: () => false, requestRender: () => {} };
		const [home, anthropic] = section.items(context as never);
		const open = (item: typeof home) => {
			const page = pageOf(item!)!("", () => {});
			if (page.kind !== "rows") throw new Error(`expected rows, got ${page.kind}`);
			return page;
		};
		const homePage = open(home);
		expect(homePage.items.map((item) => item.id)).toEqual(expect.arrayContaining(["remove-model", "remove-server"]));
		expect(homePage.items.find((item) => item.id === "remove-server")?.label).toBe(
			"Remove the server home and its 2 model(s)",
		);
		expect(open(anthropic).items.map((item) => item.id)).not.toContain("remove-model");
	});
});

// the maintainer's server went from Qwen 3.8 27B to Qwen 3.8 Flash Next; the list follows it.
describe("fork: reading a server's model list again", () => {
	let server: Server | undefined;
	afterEach(() => {
		server?.close();
		server = undefined;
	});

	it("adds the new models, removes those no longer served with their corrections, keeps the others", async () => {
		server = createServer((request, response) => {
			if (request.url === "/v1/models") {
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ data: [{ id: "qwen-3.8-flash-next" }, { id: "qwen-4-coder" }] }));
			} else {
				response.statusCode = 404;
				response.end();
			}
		});
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const path = modelsFile();
		const config = JSON.parse(readFileSync(path, "utf-8"));
		config.providers.home.baseUrl = `http://127.0.0.1:${port}/v1`;
		config.providers.home.models[1] = { id: "qwen-3.8-flash-next", contextWindow: 4096 };
		writeFileSync(path, JSON.stringify(config));

		expect(await syncCompatibleServer(path, "home", undefined)).toEqual({
			added: ["qwen-4-coder"],
			removed: ["qwen-3.8-27b"],
		});
		const home = providers(path).home;
		expect(home.models.map((model: { id: string }) => model.id)).toEqual(["qwen-3.8-flash-next", "qwen-4-coder"]);
		expect(home.models[0].contextWindow).toBe(4096);
		expect(home.modelOverrides).toBeUndefined();
		expect(await syncCompatibleServer(path, "home", undefined)).toEqual({ added: [], removed: [] });
		await expect(syncCompatibleServer(path, "anthropic", undefined)).rejects.toThrow("not a server");
	});
});
