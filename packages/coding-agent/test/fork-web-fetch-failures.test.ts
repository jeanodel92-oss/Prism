/**
 * fork: web_fetch matched Exa's results to the requested URLs without
 * their port, so a service on :8443 counted as delivered by the one on the default port and was never fetched
 * directly; and it dropped a failure whose text began with a delivered URL, so /missing vanished behind /.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import webExtension from "../src/fork/web.ts";
import { WEB_SEARCH_KEY_ENV } from "../src/fork/web-search-config.ts";

vi.mock("undici", async (original) => ({
	...(await original<Record<string, unknown>>()),
	fetch: (url: string, options: RequestInit) => fetch(url, options),
}));

type Exa = { results: Array<{ url: string; text: string }>; statuses: Array<{ id: string; status: string }> };

describe("fork: web_fetch matches each failure and result to its own URL", () => {
	let dir: string;
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-web-fetch-"));
		vi.stubEnv(ENV_AGENT_DIR, dir);
		for (const env of Object.values(WEB_SEARCH_KEY_ENV)) vi.stubEnv(env, "");
		vi.stubEnv("EXA_API_KEY", "unused-exa-test-key");
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockReset();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	async function webFetch(urls: string[], exa: Exa, direct: (url: string) => Response) {
		const tools = new Map<string, ToolDefinition>();
		const pi = {
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
			registerCommand: () => {},
			events: { emit: () => {}, on: () => () => {} },
		} as unknown as ExtensionAPI;
		await webExtension(pi);
		const directUrls: string[] = [];
		fetchMock.mockImplementation(async (input) => {
			const url = String(input);
			if (url.startsWith("https://api.exa.ai/")) return Response.json(exa);
			directUrls.push(url);
			return direct(url);
		});
		const result = await tools.get("web_fetch")!.execute("call", { urls }, undefined, undefined, {} as never);
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		return { result, text, directUrls };
	}

	it("367: fetches directly the service on another port that Exa did not deliver", async () => {
		const { text, directUrls } = await webFetch(
			["https://docs.example/page", "https://docs.example:8443/page"],
			{
				results: [{ url: "https://docs.example/page", text: "default port" }],
				statuses: [
					{ id: "https://docs.example/page", status: "success" },
					{ id: "https://docs.example:8443/page", status: "error" },
				],
			},
			() => new Response("<html><body>port 8443</body></html>", { headers: { "content-type": "text/html" } }),
		);
		expect(directUrls).toEqual(["https://docs.example:8443/page"]);
		expect(text).toContain("port 8443");
	});

	it("369: reports the failure of a page whose URL begins with a delivered one", async () => {
		const { result, text } = await webFetch(
			["https://docs.example/", "https://docs.example/missing"],
			{
				results: [{ url: "https://docs.example/", text: "home" }],
				statuses: [
					{ id: "https://docs.example/", status: "success" },
					{ id: "https://docs.example/missing", status: "error" },
				],
			},
			() => new Response("not found", { status: 404 }),
		);
		expect(text).toContain("Skipped:\nhttps://docs.example/missing: exa");
		expect(result.details).toMatchObject({ fetched: 1, failed: 2 });
	});
});
