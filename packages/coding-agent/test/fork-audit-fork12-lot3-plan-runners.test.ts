// fork: Plan mode's list lets the test runners, npm and `tsc --noEmit` through
// (running the tests is part of planning), but they run the project's code or write in it, and broad mode let them, and
// `git status` in a received repository whose configuration names a program, run without a question, while Plan mode
// promises that the project does not change. While Plan mode is on, broad mode now asks for them as ask mode does. The commands are
// the audit's.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { decidePermission, type Mode } from "../src/fork/permissions.ts";
import type { PlanBridge } from "../src/fork/plan-bridge.ts";
import { realPath } from "../src/fork/real-path.ts";
import { findBlockedCommandSegment } from "../vendor/forks/pi-plan-mode/dist/chunks/chunk-L2CXUWCH.ts";

const PLAN_BRIDGE = Symbol.for("prism.plan-mode");
const bridges = globalThis as Record<symbol, PlanBridge | undefined>;

let root: string;
/** A repository received as an archive: its own .git/config names a program. */
let received: string;
/** An ordinary repository. */
let ordinary: string;
const saved = { home: process.env.HOME, agentDir: process.env[ENV_AGENT_DIR], bridge: bridges[PLAN_BRIDGE] };

beforeAll(() => {
	root = realPath(mkdtempSync(join(tmpdir(), "prism-audit-plan-")));
	const home = join(root, "home");
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	received = join(root, "received");
	ordinary = join(root, "ordinary");
	for (const dir of [received, ordinary]) {
		execFileSync("git", ["-C", root, "init", "-q", dir], {
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
		});
	}
	appendFileSync(join(received, ".git", "config"), "[core]\n\tfsmonitor = touch pwned\n");
	process.env.HOME = home;
	process.env[ENV_AGENT_DIR] = join(home, ".pi", "agent");
});

afterEach(() => {
	bridges[PLAN_BRIDGE] = saved.bridge;
});

afterAll(() => {
	process.env.HOME = saved.home;
	if (saved.agentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = saved.agentDir;
	rmSync(root, { recursive: true, force: true });
});

const blocked = (command: string) => findBlockedCommandSegment(command, {}, "/work", "linux") !== undefined;
const plan = (enabled: boolean) => {
	bridges[PLAN_BRIDGE] = { toggle: () => {}, enabled: () => enabled };
};
const gate = (command: string, cwd: string, mode: Mode = "broad") =>
	decidePermission("bash", { command }, cwd, { mode }).effect;

describe("fork: security audit of fork.12, AS-028: Plan mode runs no project code unasked", () => {
	it.each([
		"cargo check",
		"cargo check --release",
		"cargo test",
		"cargo test --no-run",
		"cargo test -- --list",
		"go test ./...",
		"pytest -q",
		"vitest run",
		"jest --ci",
		"npm test",
		"npm run test",
		"npm run lint",
		"npm run check",
		"npm run typecheck",
		"npm view github:someone/somerepo --git=./helper.sh",
		"npm ls --logs-dir=.",
		"npm outdated --cache=./npm-cache",
		"tsc --noEmit",
	])("in broad mode with Plan mode on, the gate asks for %s", (command) => {
		plan(true);
		expect(gate(command, ordinary)).toBe("prompt");
		plan(false);
		expect(gate(command, ordinary)).toBe("allow");
	});

	it("keeps the reading commands and the version flags", () => {
		for (const command of ["git status", "git log --oneline", "rg -n hello .", "tsc --version", "node --version"]) {
			expect(blocked(command)).toBe(false);
		}
	});

	it("asks, in broad mode with Plan mode on, for git in a repository whose configuration runs a program", () => {
		plan(true);
		expect(gate("git status", received)).toBe("prompt");
		expect(gate("cd sub; git status", received)).toBe("prompt");
		expect(gate("git status", ordinary)).toBe("allow");
		expect(gate("rg -n hello .", ordinary)).toBe("allow");
	});

	it("leaves broad mode as it is when Plan mode is off or absent", () => {
		plan(false);
		expect(gate("git status", received)).toBe("allow");
		bridges[PLAN_BRIDGE] = undefined;
		expect(gate("git status", received)).toBe("allow");
		plan(true);
		expect(gate("git status", received, "ask")).toBe("prompt");
	});
});
