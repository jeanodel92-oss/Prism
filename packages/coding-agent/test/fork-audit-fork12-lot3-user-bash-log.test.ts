// fork: a command the user runs (`!cmd`, RPC `bash`) with a long output left its
// full output in clear in `$TMPDIR/pi-bash-*.log`, whose path the model is given, so the model's grep could guess a key
// one character at a time. The file now has the known secrets masked as the bash tool's output has, and stays 0600.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { secretLabel } from "../src/fork/secrets/mask.ts";

const KEY = "sk-audit-as035-0123456789abcdef";
let root: string;
const saved = { agentDir: process.env[ENV_AGENT_DIR], tmp: process.env.TMPDIR, key: process.env.OPENAI_API_KEY };

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "prism-audit-user-bash-"));
	mkdirSync(join(root, "agent"));
	mkdirSync(join(root, "tmp"));
	process.env[ENV_AGENT_DIR] = join(root, "agent");
	process.env.TMPDIR = join(root, "tmp");
	process.env.OPENAI_API_KEY = KEY;
});

afterAll(() => {
	for (const [name, value] of [
		[ENV_AGENT_DIR, saved.agentDir],
		["TMPDIR", saved.tmp],
		["OPENAI_API_KEY", saved.key],
	] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

/** A command that prints the key, split across two chunks, then more than the 50 KiB kept in memory. */
const operations: BashOperations = {
	exec: async (_command, _cwd, { onData }) => {
		onData(Buffer.from(`OPENAI_API_KEY=${KEY.slice(0, 10)}`));
		onData(Buffer.from(`${KEY.slice(10)}\n`));
		for (let i = 0; i < 3000; i++) onData(Buffer.from(`line ${i} of the build log\n`));
		onData(Buffer.from(`again ${KEY}\n`));
		return { exitCode: 0 };
	},
};

describe("fork: security audit of fork.12, AS-035: the full output of the user's command", () => {
	it("masks the known secrets in the file the model is pointed to, and keeps it private", async () => {
		const result = await executeBashWithOperations("cat build.log", root, operations);
		expect(result.truncated).toBe(true);
		const log = result.fullOutputPath ?? "";
		expect(log.startsWith(join(root, "tmp"))).toBe(true);
		const text = readFileSync(log, "utf8");
		expect(text).not.toContain(KEY);
		expect(text).not.toContain(KEY.slice(0, 12));
		expect(text).toContain(`OPENAI_API_KEY=${secretLabel("OPENAI_API_KEY")}`);
		expect(text).toContain(`again ${secretLabel("OPENAI_API_KEY")}`);
		expect(text).toContain("line 2999 of the build log");
		expect(statSync(log).mode & 0o777).toBe(0o600);
	});
});
