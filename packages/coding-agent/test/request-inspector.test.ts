import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import requestInspector, {
	capturePreparedRequest,
	captureProviderPayload,
	isLocalEndpoint,
	redact,
	redactEndpoint,
	requestReport,
	serializeRequestExport,
} from "../src/fork/request-inspector.ts";

describe("request inspector", () => {
	it("redacts credential headers, key fields, and bearer values", () => {
		const canary = "API_CANARY_7f16d3c08f2a";
		const safe = redact({
			headers: { "x-api-key": canary, authorization: `Bearer ${canary}` },
			payload: { apiKey: canary },
		});
		expect(JSON.stringify(safe)).not.toContain(canary);
		expect(safe).toEqual({
			headers: { "x-api-key": "[REDACTED]", authorization: "[REDACTED]" },
			payload: { apiKey: "[REDACTED]" },
		});
	});

	it("keeps token counts visible and redacts camelCase secret names", () => {
		const safe = redact({
			max_tokens: 1,
			max_completion_tokens: 2,
			maxTokens: 3,
			totalTokens: 4,
			authToken: "x",
			sessionToken: "y",
		});
		expect(safe).toEqual({
			max_tokens: 1,
			max_completion_tokens: 2,
			maxTokens: 3,
			totalTokens: 4,
			authToken: "[REDACTED]",
			sessionToken: "[REDACTED]",
		});
	});

	it("recognizes localhost and private IPv4/IPv6 endpoints", () => {
		for (const endpoint of [
			"http://localhost:8080",
			"http://127.0.0.1",
			"http://10.0.0.4",
			"http://192.168.1.3",
			"http://172.20.0.2",
			"http://[::1]",
			"http://[fd00::1]",
		]) {
			expect(isLocalEndpoint(endpoint)).toBe(true);
		}
		expect(isLocalEndpoint("https://api.example.com")).toBe(false);
	});

	it("redacts credentials in endpoint URLs", () => {
		const canary = "API_CANARY_7f16d3c08f2a";
		const endpoint = redactEndpoint(`https://user:${canary}@api.example.com/v1?access_token=${canary}`);
		expect(endpoint).not.toContain(canary);
		expect(endpoint).not.toContain("user:");
		expect(endpoint).toContain("access_token=%5BREDACTED%5D");
	});

	it("keeps the request as sent without copying the conversation (RAM pass, gui-fork10.md § 56)", () => {
		const model = { provider: "test", id: "test-model" };
		const first = { role: "user", content: "first" };
		const messages = [first];
		capturePreparedRequest(model, { messages });
		const body = { messages: [{ role: "user", content: "first" }] };
		captureProviderPayload(body, model);
		messages.push({ role: "user", content: "later" });
		body.messages.push({ role: "user", content: "later" });
		const context = { sessionManager: { getEntries: () => [] } } as unknown as ExtensionContext;
		const parsed = JSON.parse(serializeRequestExport(context)) as {
			preparedPrompt: { messages: unknown[] };
			providerPayload: { messages: unknown[] };
		};
		expect(parsed.preparedPrompt.messages).toEqual([first]);
		expect(parsed.providerPayload.messages).toHaveLength(1);
	});

	it("exports the captured request as redacted JSON", () => {
		const canary = "API_CANARY_7f16d3c08f2a";
		const model = { provider: "test", id: "test-model", baseUrl: "https://api.example.com" };
		capturePreparedRequest(model, { messages: [{ content: canary }] });
		captureProviderPayload({ headers: { authorization: `Bearer ${canary}` } }, model);
		const context = { sessionManager: { getEntries: () => [] } } as unknown as ExtensionContext;
		const exported = serializeRequestExport(context);
		const parsed = JSON.parse(exported) as Record<string, unknown>;
		expect(exported).not.toContain(canary);
		expect(parsed.provider).toBe("test");
		expect(parsed.correlationId).toBeTypeOf("number");
	});

	// /sent in session B showed the request of session A.
	it("forgets the captured request when the session changes, and keeps it across a reload", async () => {
		const handlers: Array<(event: { type: string; reason: string }) => unknown> = [];
		requestInspector({
			on: (type: string, handler: (event: { type: string; reason: string }) => unknown) => {
				if (type === "session_shutdown") handlers.push(handler);
			},
			registerCommand: () => {},
		} as unknown as ExtensionAPI);
		const shutdown = async (reason: string) => {
			for (const handler of handlers) await handler({ type: "session_shutdown", reason });
		};
		const context = { sessionManager: { getEntries: () => [] } } as unknown as ExtensionContext;
		capturePreparedRequest({ provider: "test", id: "test-model" }, { messages: [] });
		await shutdown("reload");
		expect(requestReport(context).provider).toBe("test");
		await shutdown("new");
		expect(requestReport(context)).toEqual({ message: "No model request has been captured in this session." });
	});

	it("defaults the local-to-cloud warning on and persists the setting", () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getShowLocalCloudWarning()).toBe(true);
		settings.setShowLocalCloudWarning(false);
		expect(settings.getShowLocalCloudWarning()).toBe(false);
	});
});
