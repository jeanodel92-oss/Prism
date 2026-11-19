// fork: a sign-in the provider refuses on refresh says to sign in again.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import capabilityGates from "../src/fork/capability-gates.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

// What `refreshStoredOAuthCredential` throws when OpenAI refuses the refresh token.
const REFUSED =
	'OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (400): {"error":"invalid_grant","error_description":"Refresh token revoked"}';

describe("fork: sign in again after a refused OAuth refresh", () => {
	let agentDir = "";
	let harness: Harness | undefined;

	beforeAll(() => initTheme("dark"));

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-relogin-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		setLanguage("en");
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		rmSync(agentDir, { recursive: true, force: true });
	});

	function failedRequest(errorMessage: string): string[] {
		const handlers = new Map<string, (event: Record<string, unknown>, ctx: ExtensionContext) => unknown>();
		capabilityGates({
			on: (event: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown) =>
				handlers.set(event, handler),
			getActiveTools: () => [],
			setActiveTools: () => {},
			getThinkingLevel: () => "off",
		} as unknown as ExtensionAPI);
		const notes: string[] = [];
		const ctx = {
			model: { provider: "openai-codex", id: "gpt" } as unknown as Model<Api>,
			ui: { notify: (text: string) => notes.push(text) },
		} as unknown as ExtensionContext;
		handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage } },
			ctx,
		);
		return notes;
	}

	it("says to sign in again when a request fails on a refused refresh token, in both languages", () => {
		expect(failedRequest(REFUSED)).toEqual([
			"Sign-in to openai-codex is no longer accepted. Sign in again with /login.",
		]);
		setLanguage("fr");
		expect(failedRequest(REFUSED)).toEqual([
			"La connexion à openai-codex n'est plus acceptée. Reconnectez-vous avec /login.",
		]);
	});

	it("keeps the usual note when the refresh failed for another reason", () => {
		expect(
			failedRequest("OAuth refresh failed for openai-codex: OpenAI Codex token refresh error: fetch failed"),
		).toEqual(["Model request failed. Run /doctor for local diagnostics."]);
	});

	it("says it in the model list when a catalog's refresh is refused", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([["openai-codex", new Error(REFUSED)]]),
		});
		const selector = new ModelSelectorComponent(
			{ requestRender: () => {} } as unknown as TUI,
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);
		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(160).join("\n"));
			expect(rendered).toContain("Could not refresh openai-codex; showing cached models.");
			expect(rendered).toContain("Sign in again with /login.");
		});
		selector.dispose();
	});
});
