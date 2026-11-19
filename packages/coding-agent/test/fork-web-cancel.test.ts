/**
 * fork: a cancelled web_fetch starts no further URL. Each direct fetch
 * made its own controller and listened for "abort" on the call's signal, an event that never comes again once the
 * signal is aborted: the next URLs were fetched anyway.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import webExtension, { directFetch } from "../src/fork/web.ts";
import { WEB_SEARCH_KEY_ENV } from "../src/fork/web-search-config.ts";

vi.mock("undici", async (original) => ({
	...(await original<Record<string, unknown>>()),
	fetch: (url: string, options: RequestInit) => fetch(url, options),
}));

describe("fork: a cancelled web_fetch stops", () => {
	let dir: string;
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-web-cancel-"));
		vi.stubEnv(ENV_AGENT_DIR, dir);
		for (const env of Object.values(WEB_SEARCH_KEY_ENV)) vi.stubEnv(env, "");
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockReset();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	it("sends nothing for a signal already aborted", async () => {
		await expect(directFetch("https://example.test/a", AbortSignal.abort())).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fetches none of the remaining URLs once the call is cancelled during the first", async () => {
		const tools = new Map<string, ToolDefinition>();
		const pi = {
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
			registerCommand: () => {},
			events: { emit: () => {}, on: () => () => {} },
		} as unknown as ExtensionAPI;
		await webExtension(pi);
		const controller = new AbortController();
		fetchMock.mockImplementation(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal as AbortSignal;
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					controller.abort();
				}),
		);
		const call = tools
			.get("web_fetch")!
			.execute(
				"call",
				{ urls: ["https://example.test/a", "https://example.test/b", "https://example.test/c"] },
				controller.signal,
				undefined,
				{} as never,
			);
		await expect(call).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
