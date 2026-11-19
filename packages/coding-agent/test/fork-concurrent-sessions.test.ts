import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const tempDirs: string[] = [];
const ROUNDS = 100;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createTempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "prism-concurrent-sessions-")));
	tempDirs.push(dir);
	return dir;
}

const workerSource = `
import { SettingsManager } from ${JSON.stringify(pathToFileURL(resolve(__dirname, "../src/core/settings-manager.ts")).href)};
import { SessionManager } from ${JSON.stringify(pathToFileURL(resolve(__dirname, "../src/core/session-manager.ts")).href)};
import permissionsExtension from ${JSON.stringify(pathToFileURL(resolve(__dirname, "../src/fork/permissions.ts")).href)};
import { writeModelCorrection } from ${JSON.stringify(pathToFileURL(resolve(__dirname, "../src/fork/model-settings.ts")).href)};
import { recordDetection, capabilitiesPath } from ${JSON.stringify(pathToFileURL(resolve(__dirname, "../src/fork/capability-store.ts")).href)};
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";

const role = process.env.SESSION_ROLE;
if (role !== "A" && role !== "B") throw new Error("Missing session role");
const agentDir = process.env[${JSON.stringify(ENV_AGENT_DIR)}];
const cwd = process.cwd();
const settings = SettingsManager.create(cwd, agentDir);
const session = SessionManager.create(cwd, join(agentDir, "sessions", role), { id: role });
session.appendMessage({ role: "user", content: "start", timestamp: Date.now() });

for (let round = 0; round < 6; round++) {
	if (role === "A") settings.setTheme("session-a");
	else settings.setLanguage("fr");
	settings.setDefaultModel(role + "-model-" + round);
	await settings.flush();
}

// Start the store updates together so their read-modify-write cycles overlap.
writeFileSync(join(agentDir, "ready-" + role), "");
const other = join(agentDir, "ready-" + (role === "A" ? "B" : "A"));
while (!existsSync(other)) await new Promise((resolve) => setTimeout(resolve, 5));
for (let round = 0; round < ${ROUNDS}; round++) {
	await writeModelCorrection(join(agentDir, "models.json"), role.toLowerCase(), "model-" + round, "contextWindow", 1000 + round);
	await recordDetection(capabilitiesPath(agentDir), role.toLowerCase(), [
		{ id: "model-" + round, vision: "yes", tools: "yes", reasoning: "no" },
	]);
}

const handlers = new Map();
const pi = {
	registerFlag() {},
	registerCommand() {},
	registerShortcut() {},
	registerTool() {},
	getFlag() { return undefined; },
	on(event, handler) { handlers.set(event, handler); return () => {}; },
	events: { on() { return () => {}; } },
	appendEntry(type, data) { session.appendCustomEntry(type, data); },
};
permissionsExtension(pi);
const asked = [];
const ctx = {
	cwd,
	hasUI: true,
	isProjectTrusted() { return true; },
	sessionManager: session,
	ui: {
		select: async (_title, options) => {
			asked.push(options);
			return role === "A" ? options.find((option) => option.includes("in this session")) : undefined;
		},
		notify() {},
		setStatus() {},
	},
};
await handlers.get("session_start")({}, ctx);
const result = await handlers.get("tool_call")(
	{ toolName: "write", input: { path: "shared.txt", content: role } },
	ctx,
);
if (role === "A") {
	if (result !== undefined || asked.length !== 1) throw new Error("Session grant did not allow its own call");
	const second = await handlers.get("tool_call")(
		{ toolName: "write", input: { path: "shared.txt", content: role } },
		ctx,
	);
	if (second !== undefined || asked.length !== 1) throw new Error("Session grant did not persist in its session");
} else if (!result?.block || asked.length !== 1) {
	throw new Error("Another session's grant was honored instead of prompting");
}
process.stdout.write(JSON.stringify({ role, asked: asked.length, blocked: result?.block === true }));
`;

interface ChildResult {
	role: string;
	asked: number;
	blocked: boolean;
}

function runWorker(workerPath: string, agentDir: string, cwd: string, role: "A" | "B"): Promise<ChildResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, workerPath], {
			cwd,
			env: { ...process.env, [ENV_AGENT_DIR]: agentDir, SESSION_ROLE: role, PI_OFFLINE: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timeout);
			if (code !== 0) {
				reject(new Error(`Worker ${role} failed (${signal ?? code}): ${stderr}`));
				return;
			}
			try {
				resolvePromise(JSON.parse(stdout) as ChildResult);
			} catch (error) {
				reject(new Error(`Worker ${role} returned invalid output: ${String(error)} ${stderr}`));
			}
		});
	});
}

function readJsonFiles(root: string): void {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) readJsonFiles(path);
		else if (entry.name.endsWith(".json")) JSON.parse(readFileSync(path, "utf8"));
		else if (entry.name.endsWith(".jsonl")) {
			for (const line of readFileSync(path, "utf8").trim().split("\n")) JSON.parse(line);
		}
	}
}

describe("fork: simultaneous sessions", () => {
	it("preserves concurrent settings, model stores, and session-scoped permissions", async () => {
		const root = createTempDir();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const workerPath = join(root, "worker.mjs");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(workerPath, workerSource);

		const [a, b] = await Promise.all([
			runWorker(workerPath, agentDir, cwd, "A"),
			runWorker(workerPath, agentDir, cwd, "B"),
		]);

		expect(a).toEqual({ role: "A", asked: 1, blocked: false });
		expect(b).toEqual({ role: "B", asked: 1, blocked: true });
		readJsonFiles(agentDir);

		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		expect(settings.language).toBe("fr");
		expect(settings.theme).toBe("session-a");
		// The same setting is intentionally last-writer-wins across independent sessions.
		expect(["A-model-5", "B-model-5"]).toContain(settings.defaultModel);

		const models = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as {
			providers: Record<string, { modelOverrides: Record<string, { contextWindow: number }> }>;
		};
		expect(Object.keys(models.providers)).toEqual(expect.arrayContaining(["a", "b"]));
		for (const role of ["a", "b"]) {
			for (let round = 0; round < ROUNDS; round++) {
				expect(models.providers[role]?.modelOverrides[`model-${round}`]?.contextWindow).toBe(1000 + round);
			}
		}

		const capabilities = JSON.parse(readFileSync(join(agentDir, "capabilities.json"), "utf8")) as Record<
			string,
			unknown
		>;
		for (const role of ["a", "b"]) {
			for (let round = 0; round < ROUNDS; round++) expect(capabilities[`${role}/model-${round}`]).toBeDefined();
		}

		const sessionFiles = ["A", "B"].map((role) => join(agentDir, "sessions", role));
		const entries = sessionFiles.map((dir) =>
			readFileSync(join(dir, readdirSync(dir)[0]!), "utf8")
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as {
							type?: string;
							id?: string;
							customType?: string;
							data?: { allow?: string[] };
							message?: { role?: string; content?: string };
						},
				),
		);
		for (const [index, role] of ["A", "B"].entries()) {
			expect(entries[index]?.[0]?.id).toBe(role);
			expect(
				entries[index]?.filter((entry) => entry.type === "message").map((entry) => entry.message?.content),
			).toEqual(["start"]);
		}
		expect(entries[0]?.filter((entry) => entry.customType === "perm-state")).toHaveLength(1);
		expect(entries[1]?.filter((entry) => entry.customType === "perm-state")).toHaveLength(0);
		expect(entries[0]?.find((entry) => entry.customType === "perm-state")?.data?.allow).toEqual([`write(${cwd}/**)`]);
	});
});
