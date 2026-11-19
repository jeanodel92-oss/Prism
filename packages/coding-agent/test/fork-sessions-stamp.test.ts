// fork: the phone's home asks every few seconds whether a conversation appeared on
// the PC. `sessions_stamp` answers from the folder's file names; it must change when a session file is created or
// deleted, and not otherwise.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleBuiltinCommand } from "../src/fork/rpc-builtins.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function stamp(dir: string): Promise<string> {
	const session = { sessionManager: { getSessionDir: () => dir } };
	const response = (await handleBuiltinCommand(
		{ id: "s", type: "sessions_stamp" },
		session as never,
		{} as never,
		{} as never,
		async () => {},
	)) as { success: boolean; data: { stamp: string } };
	expect(response.success).toBe(true);
	return response.data.stamp;
}

describe("sessions_stamp", () => {
	it("changes when a conversation is created or deleted, not when one is written to", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-stamp-"));
		dirs.push(dir);
		const first = join(dir, "2026-11-14T10-00-00-000Z_a.jsonl");
		writeFileSync(first, "{}\n");
		const before = await stamp(dir);

		writeFileSync(first, "{}\n{}\n");
		writeFileSync(join(dir, "notes.txt"), "not a session");
		expect(await stamp(dir)).toBe(before);

		const second = join(dir, "2026-11-14T10-05-00-000Z_b.jsonl");
		writeFileSync(second, "{}\n");
		const created = await stamp(dir);
		expect(created).not.toBe(before);

		rmSync(second);
		expect(await stamp(dir)).toBe(before);
	});

	it("answers with an empty stamp for a folder that does not exist yet", async () => {
		expect(await stamp(join(tmpdir(), "prism-stamp-missing", "nothing"))).toBe("");
	});
});
