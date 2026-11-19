import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { beforeAll, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(() => ({ status: 0 })),
}));

vi.mock("node:child_process", () => childProcessMocks);

import { NativeShareView } from "../src/fork/share-native.ts";
import { shareSession } from "../src/modes/interactive/session-share.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("shareSession", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps concurrent session exports isolated", async () => {
		const uploads: string[] = [];
		childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
			uploads.push(readFileSync(args.at(-1)!, "utf8"));
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: vi.fn(),
			});
			queueMicrotask(() => {
				child.stdout.end(`https://gist.github.com/test/${uploads.length}\n`);
				child.stderr.end();
				child.emit("close", 0);
			});
			return child;
		});

		const aWritten = deferred();
		const bWritten = deferred();
		const releaseB = deferred();
		const errors: string[] = [];
		const context = (name: "A" | "B") => ({
			session: {
				sessionManager: {
					getSessionId: () => name,
					getCwd: () => "/tmp",
					getBranch: () => [],
				},
				state: { systemPrompt: name, tools: [] },
				modelRuntime: { getProvider: () => undefined },
				exportToHtml: async (filePath: string) => {
					writeFileSync(filePath, name);
					if (name === "A") {
						aWritten.resolve();
						await bWritten.promise;
					} else {
						bWritten.resolve();
						await releaseB.promise;
					}
				},
			},
			ui: { setFocus() {}, requestRender() {} },
			editorContainer: { clear() {}, addChild() {} },
			editor: {},
			showStatus() {},
			showError(message: string) {
				errors.push(message);
			},
		});

		const shareA = shareSession(context("A") as never);
		await aWritten.promise;
		const shareB = shareSession(context("B") as never);
		await bWritten.promise;
		await shareA;
		releaseB.resolve();
		await shareB;

		expect(uploads).toEqual(["A", "B"]);
		expect(errors).toEqual([]);
	});

	// fork: gh failing to start is reported, never left to crash the process.
	it("reports gh failing to start and restores the editor", async () => {
		childProcessMocks.spawn.mockImplementation(() => {
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: vi.fn(),
			});
			setTimeout(() => child.emit("error", Object.assign(new Error("spawn gh EAGAIN"), { code: "EAGAIN" })), 5);
			return child;
		});
		const errors: string[] = [];
		let restored = 0;
		const context = {
			session: {
				sessionManager: { getSessionId: () => "S", getCwd: () => "/tmp", getBranch: () => [] },
				state: { systemPrompt: "S", tools: [] },
				modelRuntime: { getProvider: () => undefined },
				exportToHtml: async (filePath: string) => writeFileSync(filePath, "S"),
			},
			ui: { setFocus() {}, requestRender() {} },
			editorContainer: {
				clear() {},
				addChild() {
					restored++;
				},
			},
			editor: {},
			showStatus() {},
			showError(message: string) {
				errors.push(message);
			},
		};
		const outcome = await Promise.race([
			shareSession(context as never).then(() => "settled"),
			new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
		]);
		expect(outcome).toBe("settled");
		expect(errors).toEqual(["Failed to create gist: spawn gh EAGAIN"]);
		expect(restored).toBeGreaterThan(0);
	});

	// fork: closing the window's share panel while the session was exported left the upload
	// to start afterwards, with a loader nobody could stop: the conversation was published anyway.
	it("creates no gist when the window's panel was closed during the export", async () => {
		childProcessMocks.spawn.mockClear();
		const view = new NativeShareView(() => {});
		const context = {
			session: {
				sessionManager: { getSessionId: () => "S", getCwd: () => "/tmp", getBranch: () => [] },
				state: { systemPrompt: "S", tools: [] },
				modelRuntime: { getProvider: () => undefined },
				exportToHtml: async (filePath: string) => {
					writeFileSync(filePath, "S");
					// The user closes the panel while the HTML is written.
					view.close();
				},
			},
			ui: { setFocus() {}, requestRender() {} },
			editorContainer: { clear() {}, addChild() {} },
			editor: {},
			createLoader: (message: string) => view.createLoader(message),
			showStatus() {},
			showError() {},
		};
		await shareSession(context as never);
		expect(childProcessMocks.spawn).not.toHaveBeenCalled();
		await view.whenCancelled;
	});
});
