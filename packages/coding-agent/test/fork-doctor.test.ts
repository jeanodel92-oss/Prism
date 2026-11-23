// fork: local doctor checks, redacted export, and narrow-terminal rendering.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
} from "../src/core/extensions/types.ts";
import doctorExtension, {
	buildDoctorReport,
	buildStartupDoctorReport,
	exportDoctorReport,
	formatDoctorReport,
	isLocalUrl,
	renderDoctorLines,
} from "../src/fork/doctor.ts";
import { runDoctorCommand } from "../src/fork/doctor-cli.ts";
import {
	clearLastModelFailure,
	recordModelFailure,
	setExtensionLoadDiagnostics,
} from "../src/fork/doctor-diagnostics.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";

describe("fork: /doctor", () => {
	let root: string;
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-doctor-"));
		agentDir = join(root, "agent");
		mkdirSync(agentDir);
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		setExtensionLoadDiagnostics([]);
		clearLastModelFailure();
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		setExtensionLoadDiagnostics([]);
		clearLastModelFailure();
		vi.restoreAllMocks();
		setLanguage("en");
		rmSync(root, { recursive: true, force: true });
	});

	function context(model?: object): ExtensionContext {
		return {
			cwd: root,
			model,
			modelRegistry: { hasConfiguredAuth: vi.fn(() => false) },
			sessionManager: { getSessionDir: () => join(root, "sessions"), getSessionFile: () => join(root, "s.jsonl") },
		} as unknown as ExtensionContext;
	}

	// QA of fork.8, lot 12: with --no-session, the session folder is not tested.
	it("leaves the session folder untested when sessions are not saved", async () => {
		const ctx = { ...context(), sessionManager: { getSessionDir: () => "", getSessionFile: () => undefined } };
		const report = await buildDoctorReport(ctx as unknown as ExtensionContext);
		const folder = report.checks.find((entry) => entry.component === "Session directory");
		expect(folder?.status).toBe("not tested");
		expect(folder?.observed).toContain("--no-session");
		expect(report.checks.filter((entry) => entry.status === "problem")).toEqual([]);
	});

	// Public release audit 2026-11-23 (FIN-06): a cloud model without a key was "ok" while the header said "no model".
	it("reports a cloud model without a key as a problem, and a local server without one as ok", async () => {
		const cloud = await buildDoctorReport(
			context({ provider: "openai", id: "gpt-test", baseUrl: "https://api.openai.com/v1" }),
		);
		const remote = cloud.checks.find((entry) => entry.component === "Current model");
		expect(remote?.status).toBe("problem");
		expect(remote?.action).toContain("/login");
		const local = await buildDoctorReport(
			context({ provider: "llama", id: "qwen", baseUrl: "http://127.0.0.1:8080/v1" }),
		);
		expect(local.checks.find((entry) => entry.component === "Current model")?.status).toBe("ok");
	});

	it("reports a failed extension with a confirmed cause and a safe-mode action", async () => {
		setExtensionLoadDiagnostics([{ path: join(root, "broken.ts"), error: "SyntaxError" }]);
		const report = await buildDoctorReport(context());
		const extension = report.checks.find((entry) => entry.component === "Extensions" && entry.status === "problem");
		expect(extension?.cause).toContain("Confirmed");
		expect(extension?.action).toContain("--safe");
		expect(extension?.detail).toContain("broken.ts");
	});

	it("shows an unknown capability and never probes an unreachable model server", async () => {
		const listener = createServer();
		await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
		const { port } = listener.address() as AddressInfo;
		await new Promise<void>((resolve) => listener.close(() => resolve()));
		const unreachableUrl = `http://127.0.0.1:${port}/v1`;
		writeFileSync(
			join(agentDir, "capabilities.json"),
			JSON.stringify({ "local/test-model": { vision: "unknown", tools: "yes", reasoning: "unknown" } }),
		);
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					local: {
						baseUrl: unreachableUrl,
						api: "openai-completions",
						models: [
							{
								id: "test-model",
								name: "Test",
								reasoning: false,
								input: ["text"],
								contextWindow: 1000,
								maxTokens: 100,
							},
						],
					},
				},
			}),
		);
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const report = await buildDoctorReport(context({ provider: "local", id: "test-model", baseUrl: unreachableUrl }));
		const model = report.checks.find((entry) => entry.component === "Current model");
		const server = report.checks.find((entry) => entry.component === "Model server");
		expect(model?.observed).toContain("vision unknown");
		expect(server?.observed).toContain("local");
		expect(server?.observed).toContain("Reachability was not tested");
		expect(server?.cause).toContain("Hypothesis");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("exposes a model failure as technical detail with a distinct confirmed cause and hypothesis", async () => {
		recordModelFailure("ECONNREFUSED: connection failed");
		const report = await buildDoctorReport(context());
		const failure = report.checks.find((entry) => entry.component === "Last model request");
		const summary = formatDoctorReport(report, false);
		const detail = formatDoctorReport(report, true);
		expect(failure?.cause).toContain("Confirmed");
		expect(failure?.cause).toContain("Hypothesis");
		expect(summary).not.toContain("ECONNREFUSED");
		expect(detail).toContain("ECONNREFUSED");
		expect(detail).toContain(failure?.detail);
	});

	it("reports invalid settings and models files without exposing parser snippets", async () => {
		writeFileSync(join(agentDir, "settings.json"), "{ invalid");
		writeFileSync(join(agentDir, "models.json"), "{ invalid");
		const report = await buildDoctorReport(context());
		expect(report.checks.find((entry) => entry.component === "Global settings")?.cause).toContain("Confirmed");
		expect(report.checks.find((entry) => entry.component === "models.json")?.status).toBe("problem");
	});

	it("tells an absent models.json from a valid one, without a problem", async () => {
		const absent = (await buildDoctorReport(context())).checks.find((entry) => entry.component === "models.json");
		expect(absent).toMatchObject({ status: "ok", observed: "File is not present; defaults apply." });
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
		const valid = (await buildDoctorReport(context())).checks.find((entry) => entry.component === "models.json");
		expect(valid).toMatchObject({
			status: "ok",
			observed: "models.json parses and configured providers pass pi's validation.",
		});
	});

	it("exports redacted data with exclusive creation and mode 0600", async () => {
		const canary = "CANARY_SECRET_KEY_123456789";
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ token: canary }));
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					local: {
						baseUrl: `https://user:${canary}@example.test/v1?token=${canary}`,
						api: "openai-completions",
						headers: { Authorization: `Bearer ${canary}` },
						models: [],
					},
				},
			}),
		);
		const report = await buildDoctorReport(context());
		const path = join(root, "report.json");
		exportDoctorReport(path, report);
		const saved = readFileSync(path, "utf8");
		expect(saved).not.toContain(canary);
		expect(saved).not.toContain(homedir());
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(() => exportDoctorReport(path, report)).toThrow();
	});

	// Code review 2026-10-20 (L10): `~` was not expanded, so the report went to `<project>/~/r.json`.
	it("/doctor export expands a ~/ path", async () => {
		const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
		doctorExtension({
			on: () => {},
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
				void commands.set(name, command),
		} as unknown as ExtensionAPI);
		const notes: string[] = [];
		const ctx = { ...context(), ui: { notify: (message: string) => void notes.push(message) } };
		const savedHome = process.env.HOME;
		process.env.HOME = root;
		try {
			await commands.get("doctor")!.handler("export ~/r.json", ctx as unknown as ExtensionCommandContext);
		} finally {
			process.env.HOME = savedHome;
		}
		// GPT review B: masking is promised for recognized information only.
		expect(notes).toEqual([
			"Diagnostic report exported. Recognized sensitive information is masked; read the report before sharing it.",
		]);
		expect(statSync(join(root, "r.json")).isFile()).toBe(true);
	});

	it("wraps every rendered line to 40 columns", () => {
		const lines = renderDoctorLines(
			"A detailed diagnostic observation with a long technical path /tmp/project/settings.json",
			40,
		);
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});

	it("classes a server as local or cloud from its URL only", () => {
		for (const url of [
			"http://localhost:8080",
			"http://box.local:8080",
			"http://192.168.1.5/v1",
			"http://100.101.2.3:8080",
		])
			expect(isLocalUrl(url)).toBe(true);
		for (const url of ["https://api.example.com/v1", "http://100.128.0.1"]) expect(isLocalUrl(url)).toBe(false);
		expect(isLocalUrl(undefined)).toBeUndefined();
	});
	// the maintainer could not run doctor when Prism no longer started, and found the report
	// "very dense and raw".
	describe("prism doctor", () => {
		function crash(message: string, ageMs = 0) {
			writeFileSync(
				join(agentDir, "crashes.json"),
				JSON.stringify([
					{
						timestamp: new Date(Date.now() - ageMs).toISOString(),
						version: "1.0.0-test",
						kind: "uncaught_exception",
						message,
						stack: `Error: ${message}\n    at render (${homedir()}/x.ts:1:1)\n    at tick (node:internal)`,
						sessionFile: null,
						cwd: root,
					},
				]),
			);
		}

		async function cli(args: string[]) {
			const out: string[] = [];
			const err: string[] = [];
			vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => void out.push(parts.join(" ")));
			vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => void err.push(parts.join(" ")));
			const previousCode = process.exitCode;
			const previousCwd = process.cwd();
			process.exitCode = undefined;
			process.chdir(root);
			try {
				const handled = await runDoctorCommand(args);
				return { handled, code: process.exitCode, out: out.join("\n"), err: err.join("\n") };
			} finally {
				process.chdir(previousCwd);
				process.exitCode = previousCode;
			}
		}

		it("runs as a command before startup, with broken settings, and exits 1 on a problem", async () => {
			writeFileSync(join(agentDir, "settings.json"), '{"language":"en", broken');
			expect((await cli(["hello"])).handled).toBe(false);
			const run = await cli(["doctor"]);
			expect(run.handled).toBe(true);
			expect(run.code).toBe(1);
			// Extensions, and the keyring, which the tests turn off.
			expect(run.out).toMatch(/^Local diagnostic report · 1 problem\(s\), 2 not tested, \d+ fine/);
			expect(run.out).toContain("✗ Global settings  problem");
			expect(run.out).toContain("? Extensions  not tested");
			expect(run.out).toContain("? Keyring  not tested");
			expect(run.out).toContain("--safe");
			// No session folder before the first session: the folder that will hold it is checked, not created.
			expect(run.out).toMatch(/✓ Session directory {2}ok/);
			expect(statSync(join(agentDir, "sessions"), { throwIfNoEntry: false })).toBeUndefined();
		});

		it("follows the language of settings that parse, and exits 0 when all is fine", async () => {
			writeFileSync(join(agentDir, "settings.json"), '{"language":"fr"}');
			const run = await cli(["doctor"]);
			expect(run.code).toBeUndefined();
			expect(run.out).toMatch(/^Rapport de diagnostic local · 0 problème\(s\), 2 non testé\(s\)/);
			expect(run.out).toContain("✓ Réglages globaux  correct");
			expect((await cli(["doctor", "--help"])).out).toContain("doctor export <fichier>");
		});

		it("reports a recent crash, redacted in the export", async () => {
			const canary = "CANARY_SECRET_KEY_123456789";
			crash(`boom token=${canary}`);
			const report = await buildStartupDoctorReport({ cwd: root, agentDir, sessionDir: agentDir });
			const entry = report.checks.find((check) => check.component === "Crashes");
			expect(entry?.status).toBe("problem");
			expect(entry?.observed).toContain("1 crash(es)");
			expect(entry?.detail).toContain("at render");
			const path = join(root, "crash.json");
			const exported = await cli(["doctor", "export", path]);
			expect(exported.code).toBe(1);
			expect(exported.out).toContain("read the report before sharing it");
			const saved = readFileSync(path, "utf8");
			expect(saved).toContain("boom token=");
			expect(saved).not.toContain(canary);
			expect(saved).not.toContain(homedir());
			expect(statSync(path).mode & 0o777).toBe(0o600);
		});

		it("ignores crashes older than a week, and /doctor shows the crash check too", async () => {
			crash("old", 8 * 24 * 60 * 60 * 1000);
			const report = await buildDoctorReport(context());
			expect(report.checks.find((check) => check.component === "Crashes")?.status).toBe("ok");
		});

		it("reports a check that throws instead of failing the whole report", async () => {
			mkdirSync(join(agentDir, "settings.json"));
			const run = await cli(["doctor"]);
			expect(run.handled).toBe(true);
			expect(run.out).toContain("✗ Global settings  problem");
		});

		it("lays out a summary, then problems first, each component a block with indented fields", async () => {
			writeFileSync(join(agentDir, "settings.json"), "{ invalid");
			const text = formatDoctorReport(await buildDoctorReport(context()), false);
			const blocks = text.split("\n\n");
			expect(blocks[0]).toMatch(/^Local diagnostic report · \d+ problem\(s\)/);
			const marks = blocks.slice(1).map((block) => block[0]);
			expect(marks).toEqual([...marks].sort((a, b) => "✗?✓".indexOf(a!) - "✗?✓".indexOf(b!)));
			expect(blocks[1]).toBe(
				[
					"✗ Global settings  problem",
					"   Observed: File could not be parsed.",
					"   Cause: JSON parsing failed.",
					"   Action: Fix the JSON syntax, then run /doctor again.",
				].join("\n"),
			);
			// A passing check states what was seen, nothing to do.
			const ok = blocks.find((block) => block.startsWith("✓ Agent directory"))!;
			expect(ok.split("\n")).toHaveLength(2);
		});

		it("wraps an indented field under its indent, and fills the terminal's height", async () => {
			const lines = renderDoctorLines(`   Observed: ${"word ".repeat(30)}`, 40);
			expect(lines.length).toBeGreaterThan(1);
			for (const line of lines) expect(line.startsWith("   ")).toBe(true);

			const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
			doctorExtension({
				on: () => {},
				registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
					void commands.set(name, command),
			} as unknown as ExtensionAPI);
			let rendered: string[] = [];
			const plain = { bold: (text: string) => text, fg: (_color: string, text: string) => text };
			const ctx = {
				...context(),
				hasUI: true,
				ui: {
					notify: () => {},
					custom: async (factory: (...args: unknown[]) => { render(width: number): string[] }) => {
						const view = factory({ terminal: { rows: 30 }, requestRender() {} }, plain, undefined, () => {});
						rendered = view.render(60);
					},
				},
			};
			await commands.get("doctor")!.handler("", ctx as unknown as ExtensionCommandContext);
			expect(rendered.length).toBe(28);
		});

		it("says how to scroll and close, and where the page is", async () => {
			// the report ended on its last check, with no Esc, PgUp/PgDn or position.
			const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
			doctorExtension({
				on: () => {},
				registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
					void commands.set(name, command),
			} as unknown as ExtensionAPI);
			let view: { render(width: number): string[]; handleInput(data: string): void } | undefined;
			const plain = { bold: (text: string) => text, fg: (_color: string, text: string) => text };
			const ctx = {
				...context(),
				hasUI: true,
				ui: {
					notify: () => {},
					custom: async (factory: (...args: unknown[]) => NonNullable<typeof view>) => {
						view = factory({ terminal: { rows: 12 }, requestRender() {} }, plain, undefined, () => {});
					},
				},
			};
			await commands.get("doctor")!.handler("", ctx as unknown as ExtensionCommandContext);
			const first = view!.render(40);
			expect(first.length).toBeLessThanOrEqual(10);
			expect(first.slice(-2).join(" ")).toMatch(/^1-\d+ \/ \d+ · ↑↓ scroll · PgUp\/PgDn page/);
			expect(first.slice(-2).join(" ")).toContain("Esc close");
			view!.handleInput("\x1b[F");
			expect(view!.render(40).slice(-2).join(" ")).toMatch(/^(\d+)-(\d+) \/ \2 ·/);
		});
	});
});
