/**
 * fork: a path names the object it names, whatever
 * characters it holds, and a check and its use compare the same object.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { getMissingSessionCwdIssue } from "../src/core/session-cwd.ts";
import { createLsTool } from "../src/core/tools/ls.ts";
import { resolveToCwd } from "../src/core/tools/path-utils.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createWriteTool } from "../src/core/tools/write.ts";
import { hasTrustRequiringProjectResources } from "../src/core/trust-manager.ts";
import { decidePermission } from "../src/fork/permissions.ts";
import { realPath } from "../src/fork/real-path.ts";
import { isReadable, readableSet } from "../src/fork/sandbox/read-limit.ts";
import { overrideSshFiles, sandboxWrites, sshPlan } from "../src/fork/sandbox/ssh-provenance.ts";

let root: string;
const saved = process.env[ENV_AGENT_DIR];

beforeEach(() => {
	root = realPath(mkdtempSync(join(tmpdir(), "prism-path-forms-")));
	process.env[ENV_AGENT_DIR] = join(root, "agent");
	mkdirSync(join(root, "agent"), { recursive: true });
});

afterEach(() => {
	vi.unstubAllEnvs();
	overrideSshFiles(undefined);
	if (saved === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = saved;
	rmSync(root, { recursive: true, force: true });
});

const text = (result: { content: { type: string; text?: string }[] }) =>
	result.content.map((part) => part.text ?? "").join("");

describe("fork: path forms", () => {
	it("opens the exact name before its typed form", async () => {
		const nbsp = join(root, "a b.txt");
		const ascii = join(root, "a b.txt");
		writeFileSync(nbsp, "non-breaking\n");
		writeFileSync(ascii, "ascii\n");
		expect(resolveToCwd("a b.txt", root)).toBe(nbsp);
		expect(text(await createReadTool(root).execute("r", { path: "a b.txt" }))).toContain("non-breaking");
		await createWriteTool(root).execute("w", { path: "a b.txt", content: "written\n" });
		expect(readFileSync(nbsp, "utf8")).toBe("written\n");
		expect(readFileSync(ascii, "utf8")).toBe("ascii\n");
		// Only the typed form exists: it is still found.
		rmSync(nbsp);
		expect(resolveToCwd("a b.txt", root)).toBe(ascii);
	});

	it("loads the resource discovery named, trailing space included", async () => {
		// A folder whose name ends with a space, next to one without.
		mkdirSync(join(root, "prompts "));
		mkdirSync(join(root, "prompts"));
		writeFileSync(join(root, "prompts ", "hello.md"), "the spaced one\n");
		writeFileSync(join(root, "prompts", "hello.md"), "the trimmed one\n");
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			additionalPromptTemplatePaths: [join(root, "prompts ")],
			noExtensions: true,
			noSkills: true,
			noThemes: true,
		});
		await loader.reload();
		const loaded = loader.getPrompts().prompts.map((prompt) => prompt.content.trim());
		expect(loaded).toContain("the spaced one");
		expect(loaded).not.toContain("the trimmed one");
	});

	it("protects a file below a folder whose name holds a line break", () => {
		const project = join(root, "project");
		mkdirSync(join(project, "private\ncopy"), { recursive: true });
		mkdirSync(join(project, ".git"));
		const env = join(project, "private\ncopy", ".env");
		writeFileSync(env, "x");
		expect(decidePermission("read", { path: env }, project, { mode: "broad" }).tier).toBe("danger");
		// A user's deny rule with ** too.
		const deny = decidePermission("read", { path: join(project, "secrets", "a\nb", "k") }, project, {
			mode: "broad",
			deny: ["read(secrets/**)"],
		});
		expect(deny.effect).toBe("block");
	});

	it("reads Git's top level whole, line break included", () => {
		const home = join(root, "home");
		const repo = join(home, "Documents\nwork");
		mkdirSync(repo, { recursive: true });
		mkdirSync(join(home, "Documents"));
		writeFileSync(join(home, "Documents", "private.txt"), "x");
		execFileSync("git", ["init", "-q"], { cwd: repo });
		const set = readableSet({ cwd: repo, home, env: { PATH: "/usr/bin:/bin" } });
		expect(isReadable(set, join(home, "Documents", "private.txt"))).toBe(false);
		expect(isReadable(set, join(repo, "file.txt"))).toBe(true);
	});

	it("treats a session folder that became a file as missing, a link to a folder as there", () => {
		const source = (cwd: string) => ({ getCwd: () => cwd, getSessionFile: () => join(root, "s.jsonl") });
		writeFileSync(join(root, "file"), "x");
		mkdirSync(join(root, "dir"));
		symlinkSync(join(root, "dir"), join(root, "link"));
		expect(getMissingSessionCwdIssue(source(join(root, "file")), root)).toBeDefined();
		expect(getMissingSessionCwdIssue(source(join(root, "dir")), root)).toBeUndefined();
		expect(getMissingSessionCwdIssue(source(join(root, "link")), root)).toBeUndefined();
	});

	it("asks for trust when only the parent of a linked cwd holds instructions", () => {
		vi.stubEnv("HOME", join(root, "home"));
		mkdirSync(join(root, "clean"));
		mkdirSync(join(root, "untrusted"));
		writeFileSync(join(root, "untrusted", "AGENTS.md"), "instructions");
		symlinkSync(join(root, "clean"), join(root, "untrusted", "link"));
		expect(hasTrustRequiringProjectResources(join(root, "clean"))).toBe(false);
		expect(hasTrustRequiringProjectResources(join(root, "untrusted", "link"))).toBe(true);
	});

	it("judges a relative SSH option path from / as well as from the home folder", () => {
		const home = join(root, "home");
		const work = join(root, "work");
		mkdirSync(join(home, ".ssh"), { recursive: true });
		mkdirSync(work);
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "ssh"), "#!/bin/sh\n", { mode: 0o755 });
		overrideSshFiles({ home, system: join(root, "ssh_config") });
		writeFileSync(join(home, ".ssh", "config"), `Host *\n  PKCS11Provider ${work.slice(1)}/token.so\n`);
		const writes = sandboxWrites({ writable: [work], readOnly: [], hidden: [] });
		expect(sshPlan(writes, "ssh", { PATH: bin })).toMatch(/PKCS11Provider/);
	});

	it("lists a dangling link instead of calling its folder empty", async () => {
		mkdirSync(join(root, "conf"));
		symlinkSync(join(root, "gone.json"), join(root, "conf", "config.json"));
		const listing = text(await createLsTool(root).execute("l", { path: "conf" }));
		expect(listing).toContain("config.json (broken link or unreadable)");
	});
});
