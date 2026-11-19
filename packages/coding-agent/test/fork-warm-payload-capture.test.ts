/**
 * fork: a cache warm request replays the options of the request it
 * warms; its payload hook must keep the extension transform but leave the /sent capture of that request alone.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheWarmer, type CacheWarmRequest } from "../src/core/cache-warmer.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { captureProviderPayload, requestReport } from "../src/fork/request-inspector.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

describe("cache warm payloads and /sent", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	it("keeps the payload of the normal request after a warm request builds its own", async () => {
		const warmRequests: CacheWarmRequest[] = [];
		vi.spyOn(CacheWarmer.prototype, "start").mockImplementation((request) => {
			warmRequests.push(request);
		});
		const seed: Harness = await createHarness();
		cleanups.push(() => seed.cleanup());
		const dir = mkdtempSync(join(tmpdir(), "fork-warm-payload-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const extensionsResult = await createTestExtensionsResult(
			[
				{
					name: "transform",
					factory: (pi) => {
						pi.on("before_provider_request", (event) => ({ ...(event.payload as object), transformed: true }));
					},
				},
			],
			dir,
		);
		const sessionManager = SessionManager.inMemory(dir);
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: join(dir, "agent"),
			model: seed.getModel(),
			modelRuntime: seed.session.modelRuntime,
			settingsManager: seed.settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		cleanups.unshift(() => session.dispose());
		seed.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("hello");

		const warm = warmRequests.at(-1);
		if (!warm?.options.onPayload) throw new Error("Expected a warm request with a payload hook");
		// The transport of the normal request reports its payload, as the real providers do.
		captureProviderPayload({ max_tokens: 4096, transformed: true }, warm.model);
		const warmPayload = await warm.options.onPayload({ max_tokens: 1 }, warm.model);

		expect(warmPayload).toEqual({ max_tokens: 1, transformed: true });
		const context = { sessionManager } as unknown as ExtensionContext;
		expect(requestReport(context).providerPayload).toEqual({ max_tokens: 4096, transformed: true });
	});
});
