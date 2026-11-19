// fork: features follow the model's capabilities, for vision, tool calls and thinking,
// in each of the three states (yes, no, unknown).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import type { Tri } from "../src/fork/capabilities.ts";
import capabilityGates, { effectiveGates, suspects } from "../src/fork/capability-gates.ts";
import { capabilitiesPath, readCapabilities, recordDetection, writeToolCalls } from "../src/fork/capability-store.ts";
import { writeCompatibleServer } from "../src/fork/compatible-server.ts";
import { writeModelCorrection } from "../src/fork/model-settings.ts";

const STATES: Tri[] = ["yes", "no", "unknown"];

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

// fork: without a capability to suspect, a refused request points to /doctor instead.
const DOCTOR = "Model request failed. Run /doctor for local diagnostics.";

describe("fork: capability gates", () => {
	let agentDir = "";

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-gates-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	const model = (id: string) => ({ provider: "box", id }) as unknown as Model<Api>;

	/** Loads the extension against a fake pi; returns its handlers and what it did. */
	function load(activeTools = ["read", "bash"], thinking = "medium") {
		const handlers = new Map<string, Handler>();
		const state = { tools: [...activeTools], notes: [] as string[] };
		capabilityGates({
			on: (event: string, handler: Handler) => handlers.set(event, handler),
			getActiveTools: () => state.tools,
			setActiveTools: (names: string[]) => {
				state.tools = names;
			},
			getThinkingLevel: () => thinking,
		} as unknown as ExtensionAPI);
		const ctx = (current: Model<Api>) =>
			({ model: current, ui: { notify: (text: string) => state.notes.push(text) } }) as unknown as ExtensionContext;
		const fire = (event: string, payload: Record<string, unknown>, current: Model<Api>) =>
			handlers.get(event)!({ type: event, ...payload }, ctx(current));
		return { state, fire };
	}

	async function detect(id: string, vision: Tri, tools: Tri, reasoning: Tri) {
		await recordDetection(capabilitiesPath(agentDir), "box", [{ id, vision, tools, reasoning }]);
	}

	it("writes unknown capabilities as available and absent ones as off in models.json", async () => {
		const modelsPath = join(agentDir, "models.json");
		const detected = {
			kind: "generic" as const,
			models: STATES.map((state) => ({ id: state, vision: state, tools: state, reasoning: state })),
		};
		await writeCompatibleServer(
			modelsPath,
			{ providerId: "box", baseUrl: "http://x/v1", models: STATES, detected },
			"openai-completions",
			false,
		);
		const models = JSON.parse(readFileSync(modelsPath, "utf-8")).providers.box.models;
		const byId = (id: string) => models.find((entry: { id: string }) => entry.id === id);
		expect(byId("yes")).toMatchObject({ input: ["text", "image"], reasoning: true });
		expect(byId("unknown")).toMatchObject({ input: ["text", "image"], reasoning: true });
		expect(byId("no").input).toBeUndefined();
		expect(byId("no").reasoning).toBeUndefined();
	});

	it("keeps the user's tool-call choice across a new detection", async () => {
		const path = capabilitiesPath(agentDir);
		await recordDetection(path, "box", [{ id: "m", vision: "unknown", tools: "unknown", reasoning: "unknown" }]);
		await writeToolCalls(path, "box", "m", false);
		await recordDetection(path, "box", [{ id: "m", vision: "yes", tools: "yes", reasoning: "yes" }]);
		expect(readCapabilities(path, "box", "m")).toEqual({
			vision: "yes",
			tools: "yes",
			reasoning: "yes",
			toolCalls: false,
		});
	});

	it("tool calls: off while a model without them is selected, back for the next model", async () => {
		for (const state of STATES) await detect(`tools-${state}`, "yes", state, "yes");
		const { state, fire } = load();
		fire("session_start", { reason: "startup" }, model("tools-yes"));
		expect(state.tools).toEqual(["read", "bash"]);
		fire("model_select", { model: model("tools-unknown") }, model("tools-unknown"));
		expect(state.tools).toEqual(["read", "bash"]);
		fire("model_select", { model: model("tools-no") }, model("tools-no"));
		expect(state.tools).toEqual([]);
		expect(state.notes.at(-1)).toMatch(
			/^tools-no: its server says it does not support tool calls\. Prism replies without tools/,
		);
		// Another extension turns a tool on afterwards: it is set aside before the run, and comes back too.
		state.tools = ["ask_user_question"];
		fire("before_agent_start", { prompt: "hi" }, model("tools-no"));
		expect(state.tools).toEqual([]);
		fire("model_select", { model: model("tools-yes") }, model("tools-yes"));
		expect(state.tools).toEqual(["read", "bash", "ask_user_question"]);
		expect(state.notes).toHaveLength(1);

		// The user's choice wins over detection, and the message says so.
		await writeToolCalls(capabilitiesPath(agentDir), "box", "tools-yes", false);
		fire("model_select", { model: model("tools-yes") }, model("tools-yes"));
		expect(state.tools).toEqual([]);
		expect(state.notes.at(-1)).toContain("tool calls are turned off in /model-settings");
	});

	it("images: an attached image is announced as not sent only when the model has none", async () => {
		for (const state of STATES) await detect(`vision-${state}`, state, "yes", "yes");
		const { state, fire } = load();
		const image = { type: "image", data: "", mimeType: "image/png" };
		for (const vision of STATES)
			fire("input", { text: "look", images: [image], source: "interactive" }, model(`vision-${vision}`));
		expect(state.notes).toEqual([
			"this model's server says it does not accept images. The image is not sent; the model gets a note that it was left out.",
		]);
		// No image, no message.
		fire("input", { text: "hi", source: "interactive" }, model("vision-no"));
		expect(state.notes).toHaveLength(1);
		// Turned off by the user in /model-settings.
		await writeModelCorrection(join(agentDir, "models.json"), "box", "vision-yes", "vision", false);
		fire("input", { text: "look", images: [image], source: "interactive" }, model("vision-yes"));
		expect(state.notes.at(-1)).toMatch(/^images are turned off for this model in \/model-settings\./);
	});

	it("a refused request names only the unknown capabilities it used, as a hypothesis", async () => {
		for (const state of STATES) await detect(`all-${state}`, state, state, state);
		const image = { type: "image", data: "", mimeType: "image/png" };
		const error = { message: { role: "assistant", stopReason: "error" } };
		for (const state of STATES) {
			const { state: seen, fire } = load();
			fire(
				"context",
				{ messages: [{ role: "user", content: [{ type: "text", text: "x" }, image] }] },
				model(`all-${state}`),
			);
			fire("message_end", error, model(`all-${state}`));
			if (state === "unknown") {
				expect(seen.notes).toEqual([
					"The server refused the request. Possible cause, not confirmed: this model may not support images, tool calls, thinking (its server does not say). /model-settings turns it off for this model.",
				]);
			} else expect(seen.notes).toEqual([DOCTOR]);
		}
		// What the request did not use is not suspected: no image, no tools, thinking off.
		const { state: seen, fire } = load([], "off");
		fire("context", { messages: [{ role: "user", content: "x" }] }, model("all-unknown"));
		fire("message_end", error, model("all-unknown"));
		expect(seen.notes).toEqual([DOCTOR]);
		// A request that succeeded is not commented on.
		const ok = load();
		ok.fire("context", { messages: [] }, model("all-unknown"));
		ok.fire("message_end", { message: { role: "assistant", stopReason: "stop" } }, model("all-unknown"));
		expect(ok.state.notes).toEqual([]);
	});

	it("leaves models detection never saw alone", () => {
		expect(effectiveGates(undefined, {})).toBeUndefined();
		expect(suspects(undefined, { images: true, tools: true, thinking: true })).toEqual([]);
		const { state, fire } = load();
		fire("session_start", { reason: "startup" }, model("cloud"));
		fire("context", { messages: [] }, model("cloud"));
		fire("message_end", { message: { role: "assistant", stopReason: "error" } }, model("cloud"));
		expect(state.tools).toEqual(["read", "bash"]);
		expect(state.notes).toEqual([DOCTOR]);
	});

	it("thinking: the user's correction counts as known", () => {
		const gates = effectiveGates({ vision: "unknown", tools: "unknown", reasoning: "unknown" }, { reasoning: false });
		expect(gates?.reasoning).toEqual({ state: "no", source: "you" });
		expect(suspects(gates, { images: false, tools: false, thinking: true })).toEqual([]);
	});
});
