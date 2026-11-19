import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import agents, { agentFilePath, agentsPanel, type CustomAgent, readAgents } from "../src/fork/agents.ts";
import { handleInspectCommand } from "../src/fork/rpc-inspect.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const reader: CustomAgent = {
	name: "reader",
	description: 'Read "files"\ncarefully',
	tools: ["read"],
	instructions: "First line.\nSecond line.",
};

describe("native custom agent management", () => {
	let testHome: string;
	const harnesses: Harness[] = [];
	beforeEach(() => {
		testHome = mkdtempSync(join(tmpdir(), "prism-agent-panel-"));
		vi.stubEnv("HOME", testHome);
		vi.stubEnv(ENV_AGENT_DIR, testHome);
		vi.stubEnv("PRISM_SECRET_SERVICE", "off");
	});
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
		vi.unstubAllEnvs();
		rmSync(testHome, { recursive: true, force: true });
	});
	async function engine(extra: ExtensionFactory[] = []) {
		const harness = await createHarness({ extensionFactories: [agents, ...extra] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		const call = (type: string, fields: Record<string, unknown> = {}) =>
			handleInspectCommand({ type, ...fields }, harness.session);
		return { harness, call };
	}

	it("creates and edits the same Markdown format, without overwriting an existing agent at creation", async () => {
		const { call, harness } = await engine();
		expect(await call("agents_get")).toMatchObject({ agents: [], defaultTools: ["read", "grep", "find", "ls"] });
		await call("agents_save", { agent: reader });
		expect(readAgents()).toEqual([reader]);
		expect(harness.session.getAllTools().some((tool) => tool.name === "agent")).toBe(true);
		const original = readFileSync(agentFilePath(reader.name), "utf8");
		await expect(call("agents_save", { agent: { ...reader, instructions: "overwrite" } })).rejects.toThrow(
			/already exists/,
		);
		expect(readFileSync(agentFilePath(reader.name), "utf8")).toBe(original);
		await call("agents_save", {
			agent: { ...reader, instructions: "updated", tools: ["read", "grep"] },
			existingName: reader.name,
		});
		expect(readAgents()[0]).toMatchObject({ instructions: "updated", tools: ["read", "grep"] });
	});

	it("validates every submitted field, renames without overwriting another agent, and refuses a missing edit target", async () => {
		const { call } = await engine();
		for (const value of [
			null,
			{},
			{ ...reader, name: "../" },
			{ ...reader, description: " " },
			{ ...reader, instructions: 3 },
			{ ...reader, tools: "read" },
			{ ...reader, tools: [] },
			{ ...reader, tools: ["unknown"] },
			{ ...reader, model: 7 },
			{ ...reader, model: "unknown/model" },
		]) {
			await expect(call("agents_save", { agent: value })).rejects.toThrow();
		}
		expect(readAgents()).toEqual([]);
		await call("agents_save", { agent: reader });
		// an agent can be renamed; its name is written as a valid one.
		await call("agents_save", { agent: { ...reader, name: "Lecteur Rapide" }, existingName: reader.name });
		expect(readAgents().map((agent) => agent.name)).toEqual(["lecteur-rapide"]);
		await call("agents_save", { agent: reader });
		await expect(
			call("agents_save", { agent: { ...reader, name: "lecteur-rapide" }, existingName: reader.name }),
		).rejects.toThrow(/already exists/);
		expect(readAgents().map((agent) => agent.name)).toEqual(["lecteur-rapide", reader.name]);
		await expect(call("agents_save", { agent: reader, existingName: "missing" })).rejects.toThrow(/Unknown/);
		await expect(call("agents_save", { agent: reader, existingName: 3 })).rejects.toThrow(/Invalid/);
	});

	it("turns a typed name into a valid one, and accepts an empty keyword while it is off", async () => {
		const { call } = await engine();
		await call("agents_save", { agent: { ...reader, name: "Relecteur de Code" } });
		await call("agents_save", { agent: { ...reader, name: "../escape" } });
		expect(readAgents().map((agent) => agent.name)).toEqual(["escape", "relecteur-de-code"]);
		const value = { autonomous: true, explicitRequest: false, keyword: false, keywordText: "" };
		await call("agents_policy", { value });
		expect(await call("agents_get")).toMatchObject({ invocation: { autonomous: true, keywordText: "@agent" } });
		await expect(call("agents_policy", { value: { ...value, autonomous: false, keyword: true } })).rejects.toThrow(
			/keyword/,
		);
	});

	it("uses available model references, and keeps an existing temporarily unavailable reference", async () => {
		const { call, harness } = await engine();
		const model = harness.session.extensionRunner.createContext().modelRegistry.getAvailable()[0]!;
		const reference = `${model.provider}/${model.id}`;
		await call("agents_save", { agent: { ...reader, model: reference } });
		expect(readAgents()[0]?.model).toBe(reference);
		writeFileSync(
			agentFilePath(reader.name),
			readFileSync(agentFilePath(reader.name), "utf8").replace(reference, "offline/model"),
		);
		await call("agents_save", {
			agent: { ...reader, model: "offline/model", description: "updated" },
			existingName: reader.name,
		});
		expect(readAgents()[0]?.model).toBe("offline/model");
	});

	it("removes only a known agent and unregisters the panel at shutdown", async () => {
		const { call, harness } = await engine();
		await call("agents_save", { agent: reader });
		await expect(call("agents_remove", { name: "../escape" })).rejects.toThrow(/Unknown/);
		await call("agents_remove", { name: reader.name });
		expect(existsSync(agentFilePath(reader.name))).toBe(false);
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(agentsPanel(harness.session.extensionRunner.createContext())).toBeUndefined();
		await expect(call("agents_get")).rejects.toThrow(/module off/);
	});

	it("applies the keyword policy to a real faux-provider tool call before any agent can run", async () => {
		const { call, harness } = await engine();
		await call("agents_save", { agent: reader });
		const value = { autonomous: false, explicitRequest: false, keyword: true, keywordText: "@helper" };
		await call("agents_policy", { value });
		expect(JSON.parse(readFileSync(join(testHome, "settings.json"), "utf8")).agentInvocation).toEqual(value);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("agent", { agent: "reader", task: "read" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("ordinary task without a keyword");
		expect(JSON.stringify(harness.session.messages)).toContain("only when their latest message contains @helper");
		await call("agents_policy", { value: { ...value, keyword: false } });
		expect(await call("agents_get")).toMatchObject({ invocation: { autonomous: true } });
	});

	it("rejects invalid policies and preserves invalid settings without replacing them", async () => {
		const { call } = await engine();
		const value = { autonomous: false, explicitRequest: true, keyword: true, keywordText: "@agent" };
		for (const wrong of [
			null,
			{},
			{ ...value, autonomous: "yes" },
			{ ...value, keywordText: "two words" },
			{ ...value, keywordText: "x".repeat(33) },
		])
			await expect(call("agents_policy", { value: wrong })).rejects.toThrow();
		const broken = '{"agentInvocation":';
		writeFileSync(join(testHome, "settings.json"), broken);
		await expect(call("agents_policy", { value })).rejects.toThrow();
		expect(readFileSync(join(testHome, "settings.json"), "utf8")).toBe(broken);
	});

	it("turns the module off without removing agent files", async () => {
		const { call } = await engine();
		await call("agents_save", { agent: reader });
		await expect(call("agents_disable")).resolves.toEqual({ reload: true });
		expect(JSON.parse(readFileSync(join(testHome, "settings.json"), "utf8")).extensions).toContain("-builtin:agents");
		expect(existsSync(agentFilePath(reader.name))).toBe(true);
	});

	it("refuses disabling while a model turn is still active", async () => {
		let ready = () => {};
		let release = () => {};
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { call, harness } = await engine([
			(pi) =>
				pi.registerTool({
					name: "hold",
					label: "Hold",
					description: "Hold a fixture turn",
					parameters: Type.Object({}),
					async execute() {
						ready();
						await waiting;
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				}),
		]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const prompt = harness.session.prompt("wait");
		try {
			await started;
			await expect(call("agents_disable")).rejects.toThrow(/Stop the current turn/);
		} finally {
			release();
			await prompt;
		}
		expect(existsSync(join(testHome, "settings.json"))).toBe(false);
	});
});
