/**
 * fork: one invariant for every way out of Prism. A secret Prism knows reaches neither the
 * model, nor a file Prism writes, nor an export, raw or in a form a reader decodes (JSON, a property name, an archive
 * entry's name). Each output below gets the same canaries and the same check; a new output belongs in this table.
 * The canary holds a quote, a backslash, a newline and a non-ASCII letter, which JSON escapes.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { recordCrash } from "../src/core/crash-log.ts";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { serializeSessionBranch } from "../src/core/session-export.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { McpServerLog } from "../src/extensions/mcp/log.ts";
import { convertMcpResult } from "../src/extensions/mcp/tools.ts";
import backgroundExtension, { backgroundTasks } from "../src/fork/background.ts";
import { CappedLog } from "../src/fork/capped-log.ts";
import checkpointsExtension, { checkpointDir, checkpointPanel } from "../src/fork/checkpoints.ts";
import { buildPortableExport } from "../src/fork/portable-export.ts";
import { redact, redactEndpoint } from "../src/fork/request-inspector.ts";
import { rebuildUvToml } from "../src/fork/sandbox/tool-settings.ts";
import { commandEnv, knownSecrets } from "../src/fork/secrets/env.ts";
import secretsExtension from "../src/fork/secrets/extension.ts";
import { forgetKeyringCredentials } from "../src/fork/secrets/keyring.ts";
import { maskingStream, maskText, maskValue, secretName } from "../src/fork/secrets/mask.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/** Removed from commands by its name, so known; JSON escapes four of its characters. */
const CANARY = 'cnry"q\\b\nü-0123456789';
const CANARY_VAR = "PRISM_TEST_API_KEY";
/** Known only because auth.json names its variable, which has an ordinary name. */
const PLAIN = "plainvar-canary-0123456789";
const PLAIN_VAR = "PRISM_PLAIN_VAR";

const forms = (value: string) => [value, JSON.stringify(value).slice(1, -1)];

/** Every string and property name of a decoded value. */
function strings(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const entry of value) strings(entry, out);
	else if (value && typeof value === "object")
		for (const [key, entry] of Object.entries(value)) {
			out.push(key);
			strings(entry, out);
		}
	return out;
}

/** The invariant: neither canary in the bytes (raw or JSON-escaped), nor in any string or name once decoded. */
function expectClean(label: string, bytes: string | Buffer, decoded?: unknown): void {
	const text = Buffer.isBuffer(bytes) ? bytes.toString("latin1") + bytes.toString("utf8") : bytes;
	for (const canary of [CANARY, PLAIN])
		for (const form of forms(canary)) expect(text.includes(form), `${label}: ${JSON.stringify(form)}`).toBe(false);
	if (decoded !== undefined)
		for (const value of strings(decoded))
			for (const canary of [CANARY, PLAIN]) expect(value.includes(canary), `${label} (decoded)`).toBe(false);
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe("fork: known secrets at every boundary", () => {
	const saved = { agentDir: process.env[ENV_AGENT_DIR], service: process.env.PRISM_SECRET_SERVICE };
	const harnesses: Harness[] = [];
	let root: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-secrets-boundaries-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(agentDir);
		mkdirSync(cwd);
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.PRISM_SECRET_SERVICE = "off";
		process.env[CANARY_VAR] = CANARY;
		process.env[PLAIN_VAR] = PLAIN;
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ prov: { type: "api_key", key: `$${PLAIN_VAR}` } }));
		forgetKeyringCredentials();
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		delete process.env[CANARY_VAR];
		delete process.env[PLAIN_VAR];
		for (const [name, value] of [
			[ENV_AGENT_DIR, saved.agentDir],
			["PRISM_SECRET_SERVICE", saved.service],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	/** A session saved before this lot, which holds both canaries in clear. */
	function oldSession(id = "old-session"): string {
		const file = join(root, `${id}.jsonl`);
		const header = { type: "session", version: 3, id, timestamp: "2026-11-01T00:00:00.000Z", cwd };
		const message = {
			type: "message",
			id: "a1b2c3d4",
			parentId: null,
			timestamp: "2026-11-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: `${CANARY} ${PLAIN}` }], timestamp: 1 },
		};
		const answer = {
			type: "message",
			id: "b2c3d4e5",
			parentId: "a1b2c3d4",
			timestamp: "2026-11-01T00:00:02.000Z",
			message: {
				...fauxAssistantMessage("ok"),
				content: [{ type: "text", text: "ok" }],
				details: { [PLAIN]: "a secret as a name" },
			},
		};
		writeFileSync(file, `${[header, message, answer].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		return file;
	}

	it("knows a key auth.json takes from a variable, and keeps that variable from commands", () => {
		expect(knownSecrets().has(PLAIN)).toBe(true);
		expect(commandEnv(process.env, "bash", "env").removed).toContain(PLAIN_VAR);
	});

	it("recognises a secret by its field name, plural counts aside", () => {
		for (const name of ["authToken", "xPassword", "sessionToken", "access_token", "apiKey", "client_secret"])
			expect(secretName(name), name).toBe(true);
		for (const name of ["maxTokens", "tokens", "keyboard", "author"]) expect(secretName(name), name).toBe(false);
	});

	it("masks names, keeps signatures and returns what holds no secret unchanged", () => {
		const secrets = knownSecrets();
		const clean = { a: ["b", { c: 1 }] };
		expect(maskValue(clean, secrets)).toBe(clean);
		const masked = maskValue({ [PLAIN]: 1, "[secret hidden: auth.json prov]": 2, id: PLAIN }, secrets);
		expect(Object.keys(masked)).toEqual([
			"[secret hidden: auth.json prov]#2",
			"[secret hidden: auth.json prov]",
			"id",
		]);
		expect(masked.id).toBe(PLAIN);
		const shared = { text: PLAIN };
		expect(JSON.stringify(maskValue([shared, { again: shared }], secrets))).not.toContain(PLAIN);
		expect(maskText(JSON.stringify({ x: CANARY }), secrets)).not.toContain(forms(CANARY)[1]);
	});

	it("streams a short secret only once no longer one can extend it, at every cut", () => {
		const short = "tok_ABCDEFGH";
		const long = "tok_ABCDEFGH_PRIVATE_SUFFIX_0123456789";
		const secrets = new Map([
			[short, "SHORT"],
			[long, "LONG"],
		]);
		for (const text of [`x ${long} y`, `x ${short}-other y`]) {
			const expected = maskText(text, secrets);
			for (let cut = 0; cut <= text.length; cut++) {
				const out: Buffer[] = [];
				const stream = maskingStream(secrets, (data) => out.push(data));
				stream.write(Buffer.from(text.slice(0, cut)));
				stream.write(Buffer.from(text.slice(cut)));
				stream.end();
				expect(Buffer.concat(out).toString(), `${text} cut at ${cut}`).toBe(expected);
			}
		}
	});

	it("keeps both canaries out of the model's requests, the session file and the tool events", async () => {
		const sessionManager = SessionManager.create(cwd, join(root, "sessions"));
		const requests: unknown[] = [];
		const probe: AgentTool = {
			name: "probe",
			label: "probe",
			description: `A tool whose description quotes ${CANARY}`,
			parameters: Type.Object({}),
			execute: async (_id, _params, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: `progress ${CANARY}` }], details: {} });
				return { content: [{ type: "text", text: `read: ${CANARY}` }], details: { [PLAIN]: "ok" } };
			},
		};
		const harness = await createHarness({
			sessionManager,
			tools: [probe],
			extensionFactories: [
				{ name: "secrets", factory: secretsExtension },
				// The project's instructions, which the system prompt quotes.
				{
					name: "notes",
					factory: (pi) =>
						pi.on("before_agent_start", (event) => ({
							systemPrompt: `${event.systemPrompt}\nproject notes: ${CANARY}`,
						})),
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const runtime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, options) => runtime.streamSimple(model, context, options);
		const signed: AssistantMessage = {
			...fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }),
		};
		signed.content.unshift({ type: "thinking", thinking: `I recall ${PLAIN}`, thinkingSignature: "sig-1" });
		const answer = (message: AssistantMessage) => (context: unknown) => {
			requests.push(structuredClone(context));
			return message;
		};
		harness.setResponses([answer(signed), answer(fauxAssistantMessage("done")), answer(fauxAssistantMessage("ok"))]);

		// A user prompt, as @file and stdin become one.
		await harness.session.prompt(`look at ${CANARY}`);
		// A `!` command keeps the user's environment, and its output enters the session.
		await harness.session.executeBash(`printf '%s' "$${CANARY_VAR}"`);
		// A late message from an extension: a background task's end report, a sub-agent's failure.
		await harness.session.sendCustomMessage({
			customType: "agent-failed",
			content: `stderr: ${CANARY}`,
			display: true,
		});
		await harness.session.prompt("again");

		expect(requests.length).toBeGreaterThanOrEqual(3);
		const last = requests.at(-1) as { messages: { role: string; content: unknown }[] };
		const fromModel = last.messages.filter((message) => message.role === "assistant");
		const toModel = { ...last, messages: last.messages.filter((message) => message.role !== "assistant") };
		expectClean("request to the model", JSON.stringify(toModel), toModel);
		expect(JSON.stringify(last)).toContain("project notes: [secret hidden:");
		// A reasoning block goes back with its signature only as the model wrote it: a provider checks one against the
		// other. The agent's state is the session's projection, so the block comes back masked, without its signature.
		const thinking = fromModel.flatMap(
			(message) => message.content as { type: string; thinkingSignature?: string }[],
		);
		for (const block of thinking.filter((block) => block.thinkingSignature !== undefined))
			expect(block).toEqual(signed.content[0]);
		expect(JSON.stringify(thinking)).toContain("I recall [secret hidden:");

		const file = sessionManager.getSessionFile()!;
		expect(mode(file)).toBe(0o600);
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expectClean(
			"session file",
			lines.join("\n"),
			lines.map((line) => JSON.parse(line)),
		);
		expectClean("session in memory", JSON.stringify(sessionManager.getEntries()), sessionManager.getEntries());
		// A reasoning block the mask changed lost its signature, which no longer matches it.
		expect(lines.join("\n")).not.toContain("sig-1");

		const updates = harness.eventsOfType("tool_execution_update");
		expect(updates.length).toBeGreaterThan(0);
		expectClean("tool updates (CR-386)", JSON.stringify(updates), updates);
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expectClean("tool result (CR-005, CR-207)", JSON.stringify(result), result);
	}, 20_000);

	it("masks the exports of a session saved before: JSONL, HTML", async () => {
		const path = oldSession();
		const jsonl = serializeSessionBranch(SessionManager.open(path));
		expectClean(
			"JSONL export",
			jsonl,
			jsonl
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		);
		const html = readFileSync(await exportFromFile(path, join(root, "out.html")), "utf8");
		const embedded = /id="session-data" type="application\/json">([^<]*)</.exec(html)?.[1] ?? "";
		const data = Buffer.from(embedded, "base64").toString("utf8");
		expect(data).toContain("[secret hidden:");
		expectClean("HTML export", html + data, JSON.parse(data));
	});

	it("masks the portable archive, its entries' names included", () => {
		const name = `report-${PLAIN}.txt`;
		writeFileSync(join(cwd, name), `body ${CANARY}`);
		const built = buildPortableExport({ cwd, sessions: [{ path: oldSession(), id: `s-${PLAIN}` }], files: [name] });
		for (const entry of built.entries) {
			const data = typeof entry.data === "string" ? entry.data : Buffer.from(entry.data).toString("utf8");
			expectClean(
				`archive entry ${entry.name}`,
				entry.name + data,
				entry.name.endsWith(".json") ? JSON.parse(data) : undefined,
			);
		}
		const manifest = JSON.parse(String(built.entries.find((entry) => entry.name === "manifest.json")?.data));
		expect(built.entries.map((entry) => entry.name)).toContain(manifest.files[0].archivePath);
	});

	it("masks MCP's log and full output, privately", async () => {
		const log = join(agentDir, "mcp.log");
		new McpServerLog(log).write("srv", { level: "error", logger: CANARY, data: { msg: CANARY, [PLAIN]: 1 } });
		expectClean("MCP log", readFileSync(log, "utf8"));
		expect(mode(log)).toBe(0o600);
		let saved = "";
		await convertMcpResult(
			"srv",
			"tool",
			{ content: [{ type: "text", text: `${"x".repeat(30_000)} ${CANARY}` }] },
			{
				saveOutput: async (data) => {
					saved = String(data);
					return join(root, "full.txt");
				},
			},
		);
		expect(saved.length).toBeGreaterThan(30_000);
		expectClean("MCP full output", saved);
	});

	it("masks a background task's log, privately", async () => {
		writeFileSync(join(cwd, "leak.txt"), CANARY);
		const harness = await createHarness({
			extensionFactories: [{ name: "background", factory: backgroundExtension }],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("background", { action: "run", command: `cat ${join(cwd, "leak.txt")}` }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("started"),
			fauxAssistantMessage("seen"),
		]);
		await harness.session.prompt("start");
		await vi.waitFor(() => expect(backgroundTasks()?.[0]?.status).toBe("done"), { timeout: 10_000 });
		const logPath = backgroundTasks()![0]!.logPath;
		expect(readFileSync(logPath, "utf8")).toContain("[secret hidden:");
		expectClean("background log", readFileSync(logPath, "utf8"));
		expect(mode(logPath)).toBe(0o600);
		expect(mode(join(agentDir, "bg"))).toBe(0o700);
	}, 20_000);

	it("masks the crash log with the secrets already known, privately", () => {
		knownSecrets();
		const path = join(agentDir, "crashes.json");
		const error = new Error(`boom ${CANARY}`);
		error.stack = `Error: boom ${CANARY}\n    at ${PLAIN} (x.js:1:1)`;
		recordCrash({ kind: "uncaught_exception", error, cwd }, path);
		const text = readFileSync(path, "utf8");
		expectClean("crash log", text, JSON.parse(text));
		expect(mode(path)).toBe(0o600);
	});

	it("masks the inspector's report: values, names, URL parameters", () => {
		const report = redact({ body: CANARY, sessionToken: "opaque-abcdefgh", nested: { [PLAIN]: "ok" } });
		expectClean("inspector", JSON.stringify(report), report);
		expect(JSON.stringify(report)).not.toContain("opaque-abcdefgh");
		expect(
			redactEndpoint("https://api.example/v1?sessionToken=opaque-abcdefgh&authToken=opaque-ijklmnop"),
		).not.toMatch(/opaque-/);
	});

	it("encrypts /undo's backups, and restores the file byte for byte", async () => {
		const target = join(cwd, "config.txt");
		const original = Buffer.from(`key = ${CANARY}\n`);
		writeFileSync(target, original);
		const harness = await createHarness({
			sessionManager: SessionManager.create(cwd, join(root, "sessions")),
			extensionFactories: [{ name: "checkpoints", factory: checkpointsExtension }],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: target, content: "replaced\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("written"),
		]);
		await harness.session.prompt("rewrite it");
		expect(readFileSync(target, "utf8")).toBe("replaced\n");
		const folder = checkpointDir(harness.sessionManager)!;
		const blobs = readdirSync(folder).filter((name) => name.endsWith(".snap"));
		expect(blobs.length).toBe(1);
		const blob = readFileSync(join(folder, blobs[0]!));
		expectClean("undo backup", blob);
		expect(mode(join(folder, blobs[0]!))).toBe(0o600);
		const panel = checkpointPanel(harness.session.extensionRunner.createContext())!;
		const { turns } = panel.snapshot();
		const { revision } = panel.preview(turns[0]!.turn);
		const restored = await panel.restore(turns[0]!.turn, revision);
		expect(restored.failed).toEqual([]);
		expect(readFileSync(target).equals(original)).toBe(true);
	}, 20_000);

	it("keeps private the full output of a long command", async () => {
		const path = join(root, "bash-output.log");
		await new CappedLog(path).end();
		expect(mode(path)).toBe(0o600);
	});

	it("reads a registry URL's TOML escapes before judging it", () => {
		expect(rebuildUvToml('index-url = "https://user:SECRET\\u0040registry.example/simple"\n')).toBe("");
		expect(rebuildUvToml('index-url = "https://user:SECRET\\x40registry.example/simple"\n')).toBe("");
		expect(rebuildUvToml('index-url = "https://registry.example/simple"\n')).toContain("registry.example");
	});
});
