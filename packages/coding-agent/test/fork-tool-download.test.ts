/**
 * fork: a tool download writes its archive in a folder of its own, so the
 * archive whose checksum is checked is the one extracted, and no other process's download replaces or removes it.
 */
import type * as ChildProcess from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { ensureTool } from "../src/utils/tools-manager.ts";

// Set before the module loads: it fixes its download folder (the agent's bin) then, never the real one.
const agent = vi.hoisted(() => {
	// Both names the agent dir variable can have (APP_NAME is "pi" from the sources, "prism" once built).
	const names = ["PI_CODING_AGENT_DIR", "PRISM_CODING_AGENT_DIR"] as const;
	const saved = { dirs: names.map((name) => process.env[name]), offline: process.env.PI_OFFLINE };
	const dir = `${process.env.TMPDIR ?? "/tmp"}/prism-tool-download-${process.pid}-${Date.now()}`;
	for (const name of names) process.env[name] = dir;
	return { names, saved, dir };
});

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcess>();
	// No rg on the PATH: the tool is downloaded.
	return { ...actual, spawnSync: vi.fn(() => ({ error: new Error("not found") })) };
});
vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcess>();
	return { ...actual, spawnSync: vi.fn(() => ({ error: new Error("not found") })) };
});

afterAll(() => {
	agent.names.forEach((name, i) => {
		const value = agent.saved.dirs[i];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	});
	if (agent.saved.offline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = agent.saved.offline;
	vi.unstubAllGlobals();
	rmSync(agent.dir, { recursive: true, force: true });
});

it("downloads the archive into a folder of its own, not a path shared with other processes", async () => {
	expect(process.env[ENV_AGENT_DIR]).toBe(agent.dir);
	mkdirSync(agent.dir);
	delete process.env.PI_OFFLINE;
	const bin = join(agent.dir, "bin");
	let seen: string[] | undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					new ReadableStream({
						async pull(controller) {
							if (seen) return controller.close();
							controller.enqueue(new Uint8Array([1, 2, 3]));
							// While the body is written (the file is open by now): what is in the shared folder.
							await new Promise((done) => setTimeout(done, 100));
							seen = readdirSync(bin);
						},
					}),
				),
		),
	);
	// The bytes match no checksum: the tool is not installed, and nothing is left.
	const statuses: string[] = [];
	expect(await ensureTool("rg", (status) => statuses.push(status.message))).toBeUndefined();
	expect(statuses.join("\n")).toMatch(/checksum/i);
	expect(seen?.every((name) => name.startsWith("download_tmp_rg_"))).toBe(true);
	expect(readdirSync(bin)).toEqual([]);
});
