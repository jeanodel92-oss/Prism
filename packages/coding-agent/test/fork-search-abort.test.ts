/**
 * fork: a search stopped while it was being prepared starts nothing.
 * grep spawned rg after an abort that came while rg was being fetched; find spawned fd after an abort that came while
 * it looked for the enclosing repository.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holds = vi.hoisted(() => ({
	spawned: [] as string[],
	tool: undefined as Promise<void> | undefined,
	exists: undefined as Promise<void> | undefined,
	waiting: false,
}));

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	return {
		...actual,
		spawn: ((command: string, ...rest: unknown[]) => {
			holds.spawned.push(command);
			return (actual.spawn as (...args: unknown[]) => unknown)(command, ...rest);
		}) as typeof actual.spawn,
	};
});

vi.mock("../src/utils/tools-manager.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/tools-manager.ts")>();
	return {
		...actual,
		ensureTool: async (tool: "fd" | "rg") => {
			const held = holds.tool;
			if (held) {
				holds.waiting = true;
				await held;
			}
			return tool;
		},
	};
});

vi.mock("../src/core/tools/path-utils.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/tools/path-utils.ts")>();
	return {
		...actual,
		pathExists: async (path: string) => {
			const held = holds.exists;
			if (held) {
				holds.waiting = true;
				await held;
			}
			return await actual.pathExists(path);
		},
	};
});

import { createFindTool } from "../src/core/tools/find.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("fork: a search stopped during its preparation", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-search-abort-"));
		writeFileSync(join(dir, "a.txt"), "needle\n");
		holds.spawned.length = 0;
		holds.waiting = false;
	});
	afterEach(() => {
		holds.tool = undefined;
		holds.exists = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	it("grep does not start rg when stopped while rg is being fetched", async () => {
		const held = deferred();
		holds.tool = held.promise;
		const controller = new AbortController();
		const search = createGrepTool(dir).execute("call", { pattern: "needle" }, controller.signal);
		await vi.waitFor(() => expect(holds.waiting).toBe(true));
		controller.abort();
		held.resolve();
		await expect(search).rejects.toThrow("Operation aborted");
		expect(holds.spawned).toEqual([]);
	});

	it("find does not start fd when stopped while it looks for the repository", async () => {
		const held = deferred();
		holds.exists = held.promise;
		const controller = new AbortController();
		const search = createFindTool(dir).execute("call", { pattern: "*.txt" }, controller.signal);
		await vi.waitFor(() => expect(holds.waiting).toBe(true));
		controller.abort();
		await expect(search).rejects.toThrow("Operation aborted");
		held.resolve();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(holds.spawned).toEqual([]);
	});

	it("an unstopped search still runs", async () => {
		const result = await createGrepTool(dir).execute("call", { pattern: "needle" });
		expect(JSON.stringify(result.content)).toContain("needle");
		expect(holds.spawned).toEqual(["rg"]);
	});
});
