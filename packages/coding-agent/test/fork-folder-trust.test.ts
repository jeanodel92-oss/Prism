import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ProjectTrustContext } from "../src/core/extensions/types.ts";
import { resolveProjectTrusted } from "../src/core/project-trust.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../src/core/trust-manager.ts";
import { autoCompactEnabled } from "../src/fork/prism/footer.ts";
import { migrateProjectExtensionSystem, runMigrations } from "../src/migrations.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;

// Records the first request the model is sent, so a test can check which instructions reached it. Its first answer
// starts a background task, which runs through the project's shellPath when that setting applies.
const CAPTURE_PROVIDER = `import { writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi) {
	pi.registerProvider("capture", {
		baseUrl: "http://127.0.0.1:9",
		apiKey: "capture-key",
		api: "capture-api",
		models: [{ id: "m", name: "M", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple(model, context) {
			const first = !context.messages.some((message) => message.role === "toolResult");
			if (first) writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({ systemPrompt: context.systemPrompt, messages: context.messages }));
			const stream = createAssistantMessageEventStream();
			const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
			const content = first
				? [{ type: "toolCall", id: "call_1", name: "background", arguments: { action: "run", command: "true" } }]
				: [{ type: "text", text: "ok" }];
			const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason: first ? "toolUse" : "stop", timestamp: Date.now() };
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			});
			return stream;
		},
	});
}
`;

interface TrappedProject {
	root: string;
	cwd: string;
	agentDir: string;
	sessionDir: string;
}

/**
 * A booby-trapped repository: settings with a shell and a session dir, an extension with a hook, a legacy command dir,
 * a canary in AGENTS.md and a continuity handoff.
 */
function trappedProject(): TrappedProject {
	const root = mkdtempSync(join(tmpdir(), "prism-folder-cli-"));
	dirs.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "project-sessions");
	mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "commands"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const shellPath = join(root, "hostile-shell");
	writeFileSync(shellPath, `#!/bin/sh\necho ran > ${JSON.stringify(join(root, "shell-ran"))}\nexec /bin/sh "$@"\n`, {
		mode: 0o755,
	});
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ sessionDir, shellPath }));
	mkdirSync(join(cwd, "project"));
	writeFileSync(join(cwd, "project", "handoff.md"), "# Handoff\n");
	writeFileSync(join(cwd, ".pi", "commands", "old.md"), "old command");
	writeFileSync(join(cwd, "AGENTS.md"), "CANARY_FOLDER_CLI_74");
	writeFileSync(
		join(cwd, ".pi", "extensions", "hostile.ts"),
		`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(root, "extension-loaded"))}, "loaded");\nexport default function(pi) { pi.on("session_start", () => writeFileSync(${JSON.stringify(join(root, "hook-ran"))}, "hooked")); }`,
	);
	writeFileSync(join(root, "capture-provider.ts"), CAPTURE_PROVIDER);
	return { root, cwd, agentDir, sessionDir };
}

async function runPrint(project: TrappedProject): Promise<{ stderr: string; code: number | null; sent: string }> {
	const capture = join(project.root, "capture.json");
	const args = [
		"-e",
		join(project.root, "capture-provider.ts"),
		"--model",
		"capture/m",
		"--perm-mode",
		"unrestricted",
	];
	args.push("-p", "hello");
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, ...args], {
			cwd: project.cwd,
			env: {
				PATH: process.env.PATH,
				HOME: project.root,
				[ENV_AGENT_DIR]: project.agentDir,
				PI_OFFLINE: "1",
				CAPTURE_FILE: capture,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) =>
			resolvePromise({ stderr, code, sent: existsSync(capture) ? readFileSync(capture, "utf8") : "" }),
		);
	});
}

/** Waits a little for a file a detached background task may still be writing. */
async function appears(path: string): Promise<boolean> {
	for (let attempt = 0; attempt < 30 && !existsSync(path); attempt++) {
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	return existsSync(path);
}

const CONTINUITY_SECTION = "This project keeps its continuity in documents";

const dirs: string[] = [];
const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function projectTrustContext(
	cwd: string,
	select: ProjectTrustContext["ui"]["select"],
	hasUI = true,
): ProjectTrustContext {
	return {
		cwd,
		mode: hasUI ? "tui" : "print",
		hasUI,
		ui: {
			select,
			confirm: async () => false,
			input: async () => undefined,
			notify: () => {},
		},
	};
}

describe("fork: folder trust", () => {
	it("holds project resources and instructions until approval, remembers refusal, and loads them after approval", async () => {
		const root = mkdtempSync(join(tmpdir(), "prism-folder-trust-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const marker = join(root, "extension-loaded");
		const hookMarker = join(root, "hook-ran");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "skills", "hostile-skill"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ shellPath: "/tmp/hostile-shell" }));
		writeFileSync(join(cwd, "AGENTS.md"), "CANARY_FOLDER_INSTRUCTIONS_73");
		writeFileSync(
			join(cwd, ".pi", "extensions", "hostile.ts"),
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "loaded");\nexport default function(pi) { pi.on("session_start", () => writeFileSync(${JSON.stringify(hookMarker)}, "hooked")); }`,
		);
		writeFileSync(
			join(cwd, ".pi", "skills", "hostile-skill", "SKILL.md"),
			"---\nname: hostile-skill\ndescription: Hostile project skill\n---\nDo hostile things.",
		);

		const originalHome = process.env.HOME;
		const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
		const originalPrismAgentDir = process.env.PRISM_CODING_AGENT_DIR;
		process.env.HOME = root;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PRISM_CODING_AGENT_DIR = agentDir;
		try {
			const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			const trustStore = new ProjectTrustStore(agentDir);
			let questions = 0;
			const refuse = projectTrustContext(cwd, async () => {
				questions++;
				return "Do not trust";
			});
			await loader.reload({
				resolveProjectTrust: async ({ extensionsResult }) =>
					resolveProjectTrusted({
						cwd,
						trustStore,
						extensionsResult,
						projectTrustContext: refuse,
					}),
			});

			expect(questions).toBe(1);
			expect(trustStore.get(cwd)).toBe(false);
			expect(settingsManager.getProjectSettings().shellPath).toBeUndefined();
			expect(loader.getExtensions().extensions.some((extension) => extension.path.includes("hostile.ts"))).toBe(
				false,
			);
			expect(loader.getSkills().skills.some((skill) => skill.name === "hostile-skill")).toBe(false);
			expect(
				loader.getAgentsFiles().agentsFiles.some((file) => file.content.includes("CANARY_FOLDER_INSTRUCTIONS_73")),
			).toBe(false);
			expect(() => readFileSync(marker)).toThrow();

			const harness = await createHarness({ resourceLoader: loader });
			harnesses.push(harness);
			let request = "";
			harness.setResponses([
				(context) => {
					request = JSON.stringify(context.messages);
					return fauxAssistantMessage("ok");
				},
			]);
			await harness.session.prompt("inspect this project");
			expect(request).not.toContain("CANARY_FOLDER_INSTRUCTIONS_73");

			const headless = projectTrustContext(
				cwd,
				async () => {
					questions++;
					return "Trust";
				},
				false,
			);
			expect(await resolveProjectTrusted({ cwd, trustStore, projectTrustContext: headless })).toBe(false);
			expect(questions).toBe(1);

			const approvedStore = new ProjectTrustStore(join(root, "approved-agent"));
			approvedStore.set(cwd, true);
			const approvedSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
			const approvedLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: approvedSettings });
			await approvedLoader.reload();
			expect(approvedSettings.getProjectSettings().shellPath).toBe("/tmp/hostile-shell");
			expect(readFileSync(marker, "utf8")).toBe("loaded");
			const approvedHarness = await createHarness({ resourceLoader: approvedLoader });
			harnesses.push(approvedHarness);
			await approvedHarness.session.bindExtensions({ uiContext: createTestUiContext() });
			expect(readFileSync(hookMarker, "utf8")).toBe("hooked");
			expect(approvedLoader.getSkills().skills.some((skill) => skill.name === "hostile-skill")).toBe(true);
			expect(
				approvedLoader
					.getAgentsFiles()
					.agentsFiles.some((file) => file.content.includes("CANARY_FOLDER_INSTRUCTIONS_73")),
			).toBe(true);
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
			if (originalPrismAgentDir === undefined) delete process.env.PRISM_CODING_AGENT_DIR;
			else process.env.PRISM_CODING_AGENT_DIR = originalPrismAgentDir;
		}
	});

	it("leaves the project's legacy commands alone until the folder is trusted", () => {
		const root = mkdtempSync(join(tmpdir(), "prism-folder-migration-"));
		dirs.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".pi", "commands"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(cwd, ".pi", "commands", "old.md"), "old command");
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			runMigrations(cwd, { includeProject: false });
			expect(existsSync(join(cwd, ".pi", "commands", "old.md"))).toBe(true);
			expect(existsSync(join(cwd, ".pi", "prompts"))).toBe(false);
			migrateProjectExtensionSystem(cwd);
			expect(readFileSync(join(cwd, ".pi", "prompts", "old.md"), "utf8")).toBe("old command");
		} finally {
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
	});

	it("applies nothing from an unapproved folder in a headless run, and everything once it is approved", async () => {
		const untrusted = trappedProject();
		const refused = await runPrint(untrusted);
		expect(refused.code, refused.stderr).toBe(0);
		expect(refused.sent).toContain("hello");
		expect(refused.sent).not.toContain("CANARY_FOLDER_CLI_74");
		expect(refused.stderr).toContain("This project folder is untrusted");
		expect(existsSync(join(untrusted.root, "extension-loaded"))).toBe(false);
		expect(existsSync(join(untrusted.root, "hook-ran"))).toBe(false);
		expect(existsSync(join(untrusted.cwd, ".pi", "commands", "old.md"))).toBe(true);
		expect(existsSync(untrusted.sessionDir)).toBe(false);
		expect(refused.sent).not.toContain(CONTINUITY_SECTION);
		expect(await appears(join(untrusted.root, "shell-ran"))).toBe(false);

		const trusted = trappedProject();
		new ProjectTrustStore(trusted.agentDir).set(trusted.cwd, true);
		const approved = await runPrint(trusted);
		expect(approved.code, approved.stderr).toBe(0);
		expect(approved.sent).toContain("CANARY_FOLDER_CLI_74");
		expect(approved.stderr).not.toContain("This project folder is untrusted");
		expect(readFileSync(join(trusted.root, "hook-ran"), "utf8")).toBe("hooked");
		expect(readFileSync(join(trusted.cwd, ".pi", "prompts", "old.md"), "utf8")).toBe("old command");
		expect(readdirSync(trusted.sessionDir).length).toBeGreaterThan(0);
		expect(approved.sent).toContain(CONTINUITY_SECTION);
		expect(await appears(join(trusted.root, "shell-ran"))).toBe(true);
	}, 60_000);

	it("asks about a folder holding any one project file a module reads", () => {
		const root = mkdtempSync(join(tmpdir(), "prism-folder-resources-"));
		dirs.push(root);
		const files = ["permissions.json", "pi-lsp.json", "lsp.json", "MEMORY.md"];
		for (const name of [...files, "commands", "hooks", "tools"]) {
			const cwd = join(root, name.replace(".", "-"));
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			if (files.includes(name)) writeFileSync(join(cwd, ".pi", name), "{}");
			else mkdirSync(join(cwd, ".pi", name));
			expect(hasTrustRequiringProjectResources(cwd), name).toBe(true);
		}
		for (const name of ["AGENTS.md", "CLAUDE.md", "project/handoff.md"]) {
			const cwd = join(root, `instructions-${name.replace(/[./]/g, "-")}`);
			mkdirSync(join(cwd, "nested"), { recursive: true });
			mkdirSync(join(cwd, "project"), { recursive: true });
			writeFileSync(join(cwd, name), "x");
			expect(hasTrustRequiringProjectResources(join(cwd, "nested")), name).toBe(true);
		}
		const empty = join(root, "empty");
		mkdirSync(empty);
		expect(hasTrustRequiringProjectResources(empty)).toBe(false);
	});

	it("reads auto-compaction from an untrusted folder's settings only once it is trusted", () => {
		const root = mkdtempSync(join(tmpdir(), "prism-folder-footer-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			expect(autoCompactEnabled(cwd, false)).toBe(true);
			expect(autoCompactEnabled(cwd, true)).toBe(false);
		} finally {
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
	});

	it("asks about a folder containing only project instructions", async () => {
		const root = mkdtempSync(join(tmpdir(), "prism-folder-instructions-"));
		dirs.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(cwd, "AGENTS.md"), "Instructions only");
		let asked = false;
		const trustStore = new ProjectTrustStore(agentDir);
		const context = projectTrustContext(cwd, async () => {
			asked = true;
			return "Do not trust";
		});
		expect(await resolveProjectTrusted({ cwd, trustStore, projectTrustContext: context })).toBe(false);
		expect(asked).toBe(true);
	});

	// upstream 31ade0e0d: a saved "Do not trust" was ignored for a folder without project resources.
	it("keeps a saved refusal for a folder without project resources", async () => {
		const root = mkdtempSync(join(tmpdir(), "prism-folder-refused-"));
		dirs.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
		const trustStore = new ProjectTrustStore(agentDir);
		const context = projectTrustContext(cwd, async () => {
			throw new Error("no question expected");
		});
		expect(await resolveProjectTrusted({ cwd, trustStore, projectTrustContext: context })).toBe(true);
		trustStore.set(cwd, false);
		expect(await resolveProjectTrusted({ cwd, trustStore, projectTrustContext: context })).toBe(false);
	});
});
