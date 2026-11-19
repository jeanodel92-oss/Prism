// fork: the browser extension's copies in ~/Prism, which the browser runs outside
// the sandbox at its next start. The sandbox keeps them read-only for commands (fork-audit-fork12-lot3-browser); the
// edit and write tools, which run outside it, ask for them in every mode, broad included, and never for the session.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { decidePermission } from "../src/fork/permissions.ts";
import { realPath } from "../src/fork/real-path.ts";

let home: string;
const saved = { home: process.env.HOME, agentDir: process.env[ENV_AGENT_DIR] };

beforeAll(() => {
	home = realPath(mkdtempSync("/var/tmp/prism-extension-write-"));
	for (const dir of ["Prism/browser-extension", "Prism/browser-extension-firefox", "Prism/notes", ".pi/agent"])
		mkdirSync(join(home, dir), { recursive: true });
	writeFileSync(join(home, "Prism/browser-extension/background.js"), "// extension\n");
	symlinkSync(join(home, "Prism/browser-extension/background.js"), join(home, "Prism/notes/link.js"));
	process.env.HOME = home;
	process.env[ENV_AGENT_DIR] = join(home, ".pi/agent");
});

afterAll(() => {
	process.env.HOME = saved.home;
	if (saved.agentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = saved.agentDir;
	rmSync(home, { recursive: true, force: true });
});

describe("fork: security audit of fork.12, AS-025: the edit and write tools ask for the extension's copies", () => {
	it.each([
		["write", "browser-extension/background.js"],
		["edit", "browser-extension/background.js"],
		["write", "browser-extension-firefox/manifest.json"],
		["write", "notes/link.js"],
	])("%s %s asks in broad mode, the window working in ~/Prism", (tool, path) => {
		const decision = decidePermission(tool, { path }, join(home, "Prism"), { mode: "broad" });
		expect(decision.effect).toBe("prompt");
		expect(decision.reason).toContain("Prism browser extension");
	});

	it("leaves the rest of ~/Prism as it was, and reading the copies free", () => {
		const cwd = join(home, "Prism");
		expect(decidePermission("write", { path: "notes/todo.md" }, cwd, { mode: "broad" }).effect).toBe("allow");
		expect(decidePermission("read", { path: "browser-extension/background.js" }, cwd, { mode: "broad" }).effect).toBe(
			"allow",
		);
	});
});
