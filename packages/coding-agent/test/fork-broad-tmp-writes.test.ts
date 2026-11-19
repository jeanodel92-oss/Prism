// fork: in broad mode, writing under /tmp asks nothing, with the file tools as with commands, with
// and without the sandbox. Without the sandbox the write and edit tools used to ask ("write outside project"). Ask and
// safe keep their question and refusal; protected paths, the home folder, Prism's folder, links out of /tmp and hard
// links stay dangerous.
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import permissionsExtension, { decidePermission, type Mode } from "../src/fork/permissions.ts";
import { realPath } from "../src/fork/real-path.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const saved = { home: process.env.HOME, agentDir: process.env[ENV_AGENT_DIR] };
let scratch: string;
let outside: string;
let project: string;

beforeAll(() => {
	// Literally under /tmp, whatever TMPDIR says; the rest outside it.
	scratch = mkdtempSync("/tmp/prism-broad-tmp-");
	outside = realPath(mkdtempSync("/var/tmp/prism-broad-tmp-outside-"));
	project = join(outside, "project");
	mkdirSync(project);
	mkdirSync(join(outside, "agent"));
	process.env.HOME = outside;
	process.env[ENV_AGENT_DIR] = join(outside, "agent");
});

afterAll(() => {
	process.env.HOME = saved.home;
	if (saved.agentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = saved.agentDir;
	rmSync(scratch, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

const decide = (tool: string, input: Record<string, unknown>, mode: Mode) =>
	decidePermission(tool, input, project, { mode });
const edit = (path: string) => ({ path, edits: [{ oldText: "a", newText: "b" }] });

describe("fork: writes under /tmp in broad mode, without the sandbox (gate decision)", () => {
	it("lets write and edit through in broad, as commands already are", () => {
		const file = join(scratch, "notes", "out.txt");
		expect(decide("write", { path: file, content: "x" }, "broad")).toEqual({
			effect: "allow",
			reason: "broad mode",
			tier: "allow",
		});
		expect(decide("edit", edit(file), "broad").effect).toBe("allow");
		for (const command of [
			`echo hi > ${scratch}/out.txt`,
			`mkdir -p ${scratch}/d`,
			`cp package.json ${scratch}/c`,
			`rm -rf ${scratch}/d`,
		])
			expect(decide("bash", { command }, "broad").effect, command).toBe("allow");
	});

	it("keeps ask and safe as they were", () => {
		const file = join(scratch, "out.txt");
		for (const tool of ["write", "edit"]) {
			const input = tool === "write" ? { path: file, content: "x" } : edit(file);
			expect(decide(tool, input, "ask")).toEqual({
				effect: "prompt",
				reason: "This action may be dangerous: write outside project",
				tier: "danger",
			});
			expect(decide(tool, input, "safe").effect).toBe("block");
		}
		expect(decide("bash", { command: `echo hi > ${file}` }, "ask")).toMatchObject({ effect: "prompt", tier: "ask" });
		expect(decide("bash", { command: `echo hi > ${file}` }, "safe").effect).toBe("block");
	});

	it("still asks, as dangerous, for what only looks like /tmp", () => {
		// A link in /tmp to a file outside it.
		writeFileSync(join(outside, "target.txt"), "a");
		symlinkSync(join(outside, "target.txt"), join(scratch, "link.txt"));
		// A file with a second name: writing changes both.
		writeFileSync(join(scratch, "one.txt"), "a");
		linkSync(join(scratch, "one.txt"), join(scratch, "two.txt"));
		const cases: Array<[string, string]> = [
			[join(scratch, "link.txt"), "write outside project"],
			[join(scratch, "one.txt"), "hard links"],
			[join(scratch, ".git-credentials"), "protected path"],
		];
		for (const [path, reason] of cases) {
			const decision = decide("write", { path, content: "x" }, "broad");
			expect(decision.tier, path).toBe("danger");
			expect(decision.reason, path).toContain(reason);
		}
	});

	it("still asks for a home folder or Prism's folder under /tmp", () => {
		const home = join(scratch, "home");
		const agentDir = join(scratch, "agent");
		mkdirSync(home);
		mkdirSync(agentDir);
		try {
			process.env.HOME = home;
			expect(decide("write", { path: join(home, "notes.txt"), content: "x" }, "broad").tier).toBe("danger");
			process.env.HOME = outside;
			process.env[ENV_AGENT_DIR] = agentDir;
			expect(decide("write", { path: join(agentDir, "notes.txt"), content: "x" }, "broad").tier).toBe("danger");
		} finally {
			process.env.HOME = outside;
			process.env[ENV_AGENT_DIR] = join(outside, "agent");
		}
	});
});

describe("fork: writes under /tmp in broad mode, end to end", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		rmSync(join(outside, "agent", "settings.json"), { force: true });
	});

	async function start(mode: Mode, sandbox: boolean) {
		writeFileSync(join(outside, "agent", "permissions.json"), JSON.stringify({ mode }));
		if (!sandbox)
			writeFileSync(
				join(outside, "agent", "settings.json"),
				JSON.stringify({ sandbox: { modes: { safe: false, ask: false, broad: false } } }),
			);
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
		});
		harnesses.push(harness);
		const questions: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title) => {
					questions.push(title.split("\n")[0]!);
					return "Block this action once";
				},
			}),
		});
		const run = async (tool: string, input: Parameters<typeof fauxToolCall>[1]) => {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall(tool, input), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
		};
		return { questions, run };
	}

	it("writes the host's /tmp without a question when the sandbox is off; ask mode still asks", async () => {
		const broad = await start("broad", false);
		const file = join(scratch, "no-sandbox", "w.txt");
		await broad.run("write", { path: file, content: "a" });
		await broad.run("edit", edit(file));
		await broad.run("bash", { command: `echo hi > ${scratch}/no-sandbox/b.txt` });
		expect(broad.questions).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe("b");
		expect(readFileSync(join(scratch, "no-sandbox", "b.txt"), "utf8")).toBe("hi\n");

		const ask = await start("ask", false);
		await ask.run("write", { path: join(scratch, "no-sandbox", "asked.txt"), content: "a" });
		expect(ask.questions).toEqual(["Potentially dangerous action: write"]);
		expect(existsSync(join(scratch, "no-sandbox", "asked.txt"))).toBe(false);
	});

	it("writes the session's private /tmp without a question when the sandbox is on", async () => {
		const broad = await start("broad", true);
		const file = join(scratch, "sandboxed", "w.txt");
		await broad.run("write", { path: file, content: "a" });
		await broad.run("edit", edit(file));
		await broad.run("bash", { command: `mkdir -p ${scratch}/sandboxed && echo hi > ${scratch}/sandboxed/b.txt` });
		expect(broad.questions).toEqual([]);
		// The private /tmp, not the host's.
		expect(existsSync(file)).toBe(false);
	}, 60_000);
});
