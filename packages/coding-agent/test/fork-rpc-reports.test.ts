import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { lspSnapshot } from "../src/fork/lsp-inspector.ts";
import permissions from "../src/fork/permissions.ts";
import {
	capturePreparedRequest,
	captureProviderPayload,
	markProviderResponseReceived,
} from "../src/fork/request-inspector.ts";
import { handleInspectCommand } from "../src/fork/rpc-inspect.ts";
import trace, { traceSnapshot } from "../src/fork/trace.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

describe("native inspector reports", () => {
	let agentDir: string;
	const savedAgent = process.env[ENV_AGENT_DIR];
	const savedKeyring = process.env.PRISM_SECRET_SERVICE;
	const savedHome = process.env.HOME;
	const harnesses: Harness[] = [];
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-reports-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.PRISM_SECRET_SERVICE = "off";
		process.env.HOME = agentDir;
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { modes: { ask: false } } }));
	});
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
		if (savedAgent === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgent;
		if (savedKeyring === undefined) delete process.env.PRISM_SECRET_SERVICE;
		else process.env.PRISM_SECRET_SERVICE = savedKeyring;
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		rmSync(agentDir, { recursive: true, force: true });
	});
	async function engine(factories: ExtensionFactory[] = [], traceEnabled = false) {
		const harness = await createHarness({
			extensionFactories: factories,
			settings: { traceEnabled },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		const call = (type: string, extra: Record<string, unknown> = {}) =>
			handleInspectCommand({ type, ...extra }, harness.session);
		return { harness, call };
	}

	it("refuses an export before any request has been captured", async () => {
		const { call, harness } = await engine();
		await expect(call("get_request_report")).resolves.toHaveProperty("message");
		await expect(call("request_export", { path: "absent.json" })).rejects.toThrow(/No model request/);
		expect(existsSync(join(harness.tempDir, "absent.json"))).toBe(false);
	});

	it("masks each request section and exports the complete report privately without overwriting", async () => {
		const { call, harness } = await engine();
		const secret = "API_CANARY_report_secret_123456789";
		const model = {
			provider: "fixture",
			id: "fixture",
			baseUrl: `https://user:pass@example.invalid/v1?api_key=${secret}`,
		};
		harness.sessionManager.appendMessage({ role: "user", content: `inspect ${secret}`, timestamp: Date.now() });
		capturePreparedRequest(model, { apiKey: secret, text: "x".repeat(70_000), tail: "complete-tail" });
		captureProviderPayload({ authorization: secret, messages: [secret] }, model);
		markProviderResponseReceived(model);
		const report = await call("get_request_report");
		const raw = JSON.stringify(report);
		expect(raw).not.toContain(secret);
		expect(raw).not.toContain("user:pass");
		expect(report).toMatchObject({
			response: "received",
			preparedPrompt: { tail: "complete-tail", apiKey: "[REDACTED]" },
		});
		const path = join(harness.tempDir, "request.json");
		await expect(call("request_export", { path: "request.json" })).resolves.toEqual({ path });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(report);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		await expect(call("request_export", { path })).rejects.toThrow(/EEXIST/);
		await expect(call("request_export", { path: " " })).rejects.toThrow(/Usage/);
		await expect(call("request_export", { path: 42 })).rejects.toThrow(/path/);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(report);
	});

	it("reports interrupted calls from the branch and masks their arguments", async () => {
		const { call, harness } = await engine();
		harness.sessionManager.appendMessage({ role: "user", content: "go", timestamp: Date.now() });
		harness.sessionManager.appendMessage(
			fauxAssistantMessage(fauxToolCall("write", { password: "private-value" }), { stopReason: "aborted" }),
		);
		const report = await call("get_session_report");
		expect(report).toMatchObject({ status: "interrupted", calls: [{ name: "write" }], checkpoints: [] });
		expect(JSON.stringify(report)).not.toContain("private-value");
	});

	it("reports trace off without creating a trace directory and unregisters on shutdown", async () => {
		const { call, harness } = await engine([trace]);
		await expect(call("get_trace_report")).resolves.toMatchObject({ enabled: false, records: [] });
		expect(existsSync(join(agentDir, "traces"))).toBe(false);
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(traceSnapshot(harness.session.extensionRunner.createContext())).toBeUndefined();
		await expect(call("get_trace_report")).rejects.toThrow(/module off/);
	});

	it("retains refused operations and masks stored credentials in trace details", async () => {
		const secret = "fixture-stored-credential-value";
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: secret } }));
		// The default mode (broad) writes in the project without asking: ask mode, whose unanswered question refuses.
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
		const { call, harness } = await engine([trace, permissions], true);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: join(harness.tempDir, "denied.txt"), content: secret }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const report = (await call("get_trace_report")) as { records: { state: string }[] };
		expect(report.records.map((record) => record.state)).toEqual(["called", "denied", "error"]);
		expect(JSON.stringify(report)).not.toContain(secret);
		expect(existsSync(join(harness.tempDir, "denied.txt"))).toBe(false);
	});

	it("reads the loaded LSP fork's runtime, respects switches, and never starts a server", async () => {
		const witness = join(agentDir, "server-started");
		writeFileSync(
			join(agentDir, "pi-lsp.json"),
			JSON.stringify({
				servers: {
					ready: {
						command: [
							process.execPath,
							"-e",
							`require('node:fs').writeFileSync(${JSON.stringify(witness)},'started')`,
						],
						extensions: [".fixture"],
						env: { API_KEY: "fixture-env-secret" },
					},
					missing: { command: ["prism-does-not-exist"], extensions: [".other"] },
					off: { command: [process.execPath], extensions: [".off"] },
				},
			}),
		);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ lsp: { disabled: ["off"] } }));
		const lsp = builtInExtensions.find((entry) => typeof entry !== "function" && entry.name === "pi-lsp");
		if (!lsp || typeof lsp === "function") throw new Error("Missing bundled pi-lsp");
		const { call, harness } = await engine([lsp.factory]);
		const report = await call("get_lsp_report");
		expect(report).toMatchObject({
			servers: [
				{ name: "ready", state: "ready" },
				{ name: "missing", state: "missing" },
				{ name: "off", state: "off" },
			],
		});
		expect(JSON.stringify(report)).not.toContain("fixture-env-secret");
		expect(existsSync(witness)).toBe(false);
		const config = readFileSync(join(agentDir, "pi-lsp.json"), "utf8");
		rmSync(join(agentDir, "pi-lsp.json"));
		writeFileSync(join(agentDir, "lsp.json"), config);
		await expect(call("get_lsp_report")).resolves.toHaveProperty("notice", expect.stringContaining("Using legacy"));
		writeFileSync(join(agentDir, "pi-lsp.json"), "{broken");
		await expect(call("get_lsp_report")).rejects.toThrow();
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(lspSnapshot(harness.session.extensionRunner.createContext())).toBeUndefined();
		await expect(call("get_lsp_report")).rejects.toThrow(/module off/);
	});
});
