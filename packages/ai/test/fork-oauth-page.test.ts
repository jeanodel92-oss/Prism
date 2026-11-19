// fork: the harness brands the local OAuth callback page (title and logo).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getOAuthBrandName, oauthErrorHtml, oauthSuccessHtml, setOAuthPageBrand } from "../src/utils/oauth-page.ts";

describe("fork: OAuth callback page brand", () => {
	const original = oauthSuccessHtml("x");
	afterEach(() => setOAuthPageBrand({ name: "", logoSvg: original.match(/<div class="logo">(.*?)<\/div>/s)![1]! }));

	it("shows the harness name in the title and its logo", () => {
		setOAuthPageBrand({ name: "Prism", logoSvg: "<svg id='prism'></svg>" });
		const page = oauthSuccessHtml("ChatGPT authentication completed. You can close this window.");
		expect(page).toContain("<title>Prism · Authentication successful</title>");
		expect(page).toContain("<svg id='prism'></svg>");
		expect(oauthErrorHtml("no")).toContain("<title>Prism · Authentication failed</title>");
		expect(getOAuthBrandName()).toBe("Prism");
	});

	it("keeps upstream's page without a brand", () => {
		expect(original).toContain("<title>Authentication successful</title>");
		expect(getOAuthBrandName()).toBeUndefined();
	});

	// the bundle emits each OAuth flow as a self-contained file with its own copy of this module, so a
	// brand kept in a module variable never reached the ChatGPT page (pi's logo and title, agent name "Pi").
	it("reaches every copy of the module, as in the bundle's self-contained OAuth flows", () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-oauth-brand-"));
		try {
			const source = join(import.meta.dirname, "../src/utils/oauth-page.ts");
			copyFileSync(source, join(dir, "main-copy.ts"));
			copyFileSync(source, join(dir, "flow-copy.ts"));
			writeFileSync(
				join(dir, "run.mjs"),
				[
					'import { setOAuthPageBrand } from "./main-copy.ts";',
					'import * as flow from "./flow-copy.ts";',
					'setOAuthPageBrand({ name: "Prism", logoSvg: "<svg id=\'prism\'></svg>" });',
					'console.log(JSON.stringify({ name: flow.getOAuthBrandName?.(), page: flow.oauthSuccessHtml("ok") }));',
				].join("\n"),
			);
			const out = execFileSync(
				process.execPath,
				["--experimental-strip-types", "--no-warnings", join(dir, "run.mjs")],
				{
					encoding: "utf8",
				},
			);
			const { name, page } = JSON.parse(out) as { name?: string; page: string };
			expect(page).toContain("<title>Prism · Authentication successful</title>");
			expect(page).toContain("<svg id='prism'></svg>");
			expect(name).toBe("Prism");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
