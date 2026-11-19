// fork: the Codex browser login names a branded harness (originator), as the ChatGPT flow's
// agent name does; the callback page is branded by setOAuthPageBrand for every flow (fork-oauth-page.test.ts).
import { afterEach, describe, expect, it } from "vitest";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import { oauthSuccessHtml, setOAuthPageBrand } from "../src/utils/oauth-page.ts";

async function authorizeUrl(): Promise<URL> {
	let url = "";
	await expect(
		openaiCodexOAuth.login({
			signal: new AbortController().signal,
			notify: (event) => {
				if (event.type === "auth_url") url = event.url;
			},
			prompt: async (prompt) => {
				if (prompt.type === "select") return "browser";
				throw new Error("stop after the authorization URL");
			},
		}),
	).rejects.toThrow();
	return new URL(url);
}

describe("fork: the Codex login's originator", () => {
	const original = oauthSuccessHtml("x");
	afterEach(() => setOAuthPageBrand({ name: "", logoSvg: original.match(/<div class="logo">(.*?)<\/div>/s)![1]! }));

	it("is the harness's name in a branded build, and pi's otherwise", async () => {
		expect((await authorizeUrl()).searchParams.get("originator")).toBe("pi");
		setOAuthPageBrand({ name: "Prism", logoSvg: "<svg id='prism'></svg>" });
		expect((await authorizeUrl()).searchParams.get("originator")).toBe("prism");
	});
});
