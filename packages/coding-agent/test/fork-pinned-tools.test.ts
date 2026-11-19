import type * as ChildProcess from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { verifyPinnedDownload } from "../src/fork/pinned-tools.ts";
import { ensureTool, type ToolStatus } from "../src/utils/tools-manager.ts";

// The download goes to the agent dir's bin folder: a throwaway one, set before the tools manager loads
// (vitest hoists this above the imports).
const agentDir = vi.hoisted(() => {
	const dir = `${process.env.TMPDIR ?? "/tmp"}/prism-pinned-tools-${process.pid}`;
	process.env.PRISM_CODING_AGENT_DIR = dir;
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
});

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcess>();
	// No fd or rg on PATH: the tools manager downloads them.
	return { ...actual, spawnSync: vi.fn(() => ({ error: new Error("not found") })) };
});

const originalOffline = process.env.PI_OFFLINE;

afterEach(() => {
	if (originalOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = originalOffline;
	vi.unstubAllGlobals();
});

afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

describe("fork: downloaded tools are pinned and checked", () => {
	it("refuses and deletes an archive that does not match its checksum", async () => {
		delete process.env.PI_OFFLINE;
		const fetchMock = vi.fn(async () => new Response("not the real fd archive", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const statuses: ToolStatus[] = [];

		const result = await ensureTool("fd", (status) => statuses.push(status));

		expect(result).toBeUndefined();
		// The pinned release, not the latest one: no lookup before the download.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("/sharkdp/fd/releases/download/v10.5.0/");
		expect(statuses.at(-1)?.type).toBe("warning");
		expect(statuses.at(-1)?.message).toMatch(
			/^Failed to download fd: fd-v10\.5\.0-.* does not match its known checksum/,
		);
		// Nothing left in the bin folder: neither the archive nor a binary.
		expect(readdirSync(join(agentDir, "bin"))).toEqual([]);
	});

	it("refuses an archive it has no checksum for", () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-pinned-"));
		const file = join(dir, "fd.tar.gz");
		writeFileSync(file, "x");
		try {
			expect(() => verifyPinnedDownload("fd", "fd-v99.0.0-x86_64-unknown-linux-musl.tar.gz", file)).toThrow(
				"has no known checksum",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
