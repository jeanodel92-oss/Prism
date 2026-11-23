// fork: regression tests for upstream fixes ported one by one.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { resolveCliModel } from "../src/core/model-resolver.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { DEFAULT_LLAMA_SERVER_URL } from "../src/extensions/llama/provider.ts";
import { LoginDialogComponent, webUrl } from "../src/modes/interactive/components/login-dialog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { openBrowser } from "../src/utils/open-browser.ts";

vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

describe("fork: login opens only web URLs (upstream 89c921d8b)", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		vi.mocked(openBrowser).mockReset();
		setKeybindings(new KeybindingsManager());
	});

	it("keeps http(s) and refuses files and custom protocols", () => {
		expect(webUrl("https://example.com/authorize")).toBe("https://example.com/authorize");
		expect(webUrl("http://127.0.0.1:1455/cb")).toBe("http://127.0.0.1:1455/cb");
		for (const value of ["file:///etc/passwd", "ms-msdt:/id", "search-ms:query=x", "javascript:alert(1)", "nope"]) {
			expect(webUrl(value)).toBeUndefined();
		}
	});

	it("does not hand a non-web sign-in URL to the platform launcher", () => {
		const dialog = new LoginDialogComponent({ requestRender: vi.fn() } as unknown as TUI, "p", () => {}, "P");
		dialog.showAuth("file:///home/victim/Downloads/payload.desktop");
		expect(openBrowser).not.toHaveBeenCalled();

		dialog.showAuth("https://example.com/authorize");
		expect(openBrowser).toHaveBeenCalledExactlyOnceWith("https://example.com/authorize");
	});
});

describe("fork: --model with a provider id that contains a slash (upstream 984cf6643)", () => {
	const model = (provider: string, id: string): Model<Api> =>
		({
			provider,
			id,
			name: id,
			api: "openai-completions",
			baseUrl: "http://host:10800/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 8_000,
		}) as Model<Api>;
	const models = [model("llama=http://host:10800", "unsloth/qwen-gguf:BF16"), model("llama", "other")];
	const modelRuntime = { getModels: () => models } as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

	it("splits at the longest known provider id, with or without a thinking suffix", () => {
		for (const [cliModel, thinkingLevel] of [
			["llama=http://host:10800/unsloth/qwen-gguf:BF16", undefined],
			["llama=http://host:10800/unsloth/qwen-gguf:BF16:high", "high"],
		] as const) {
			const result = resolveCliModel({ cliModel, modelRuntime });
			expect(result.error).toBeUndefined();
			expect(result.model?.provider).toBe("llama=http://host:10800");
			expect(result.model?.id).toBe("unsloth/qwen-gguf:BF16");
			expect(result.thinkingLevel).toBe(thinkingLevel);
		}
	});

	it("prefers the longer provider id when a shorter one is its prefix", () => {
		const nested = [model("gw", "plain"), model("gw/eu", "m")];
		const runtime = { getModels: () => nested } as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];
		for (const cliModel of ["gw/eu/m", "gw/eu/m:high"]) {
			const result = resolveCliModel({ cliModel, modelRuntime: runtime });
			expect(result.error).toBeUndefined();
			expect(`${result.model?.provider}/${result.model?.id}`).toBe("gw/eu/m");
		}
	});
});

describe("fork: llama.cpp default URL (upstream b3c2e4a6b)", () => {
	it("is llama-server's current default port", () => {
		expect(DEFAULT_LLAMA_SERVER_URL).toBe("http://127.0.0.1:9931");
	});
});

describe("fork: find drops a leading ./ (upstream bbfc6c7ce, #12020)", () => {
	it("finds ./src/*.ts and treats ./*.json like *.json", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "prism-find-dot-")));
		try {
			mkdirSync(join(root, "src"));
			writeFileSync(join(root, "src", "a.ts"), "a");
			writeFileSync(join(root, "src", "b.json"), "{}");
			writeFileSync(join(root, "package.json"), "{}");
			const def = createFindToolDefinition(root);
			const run = async (pattern: string): Promise<string[]> => {
				const ctx = {} as Parameters<typeof def.execute>[4];
				const result = await def.execute("call", { pattern }, undefined, undefined, ctx);
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				return text.split("\n").sort();
			};
			for (const pattern of ["./src/*.ts", "./src/**/*.ts", "././src/*.ts"]) {
				expect(await run(pattern)).toEqual(["src/a.ts"]);
			}
			expect(await run("./*.json")).toEqual(["package.json", "src/b.json"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
