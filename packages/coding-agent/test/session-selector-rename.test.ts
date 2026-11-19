import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
	};
}

// Kitty keyboard protocol encoding for Ctrl+R
const CTRL_R = "\x1b[114;5u";

describe("session selector rename", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	it("shows rename hint in interactive /resume picker configuration", async () => {
		const sessions = [makeSession({ id: "a" })];
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ showRenameHint: true, keybindings },
		);
		await flushPromises();

		const output = selector.render(120).join("\n");
		expect(output).toContain("ctrl+r");
		expect(output).toContain("rename");
	});

	it("does not show rename hint in --resume picker configuration", async () => {
		const sessions = [makeSession({ id: "a" })];
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ showRenameHint: false, keybindings },
		);
		await flushPromises();

		const output = selector.render(120).join("\n");
		expect(output).not.toContain("ctrl+r");
		expect(output).not.toContain("rename");
	});

	it("enters rename mode on Ctrl+R and submits with Enter", async () => {
		const sessions = [makeSession({ id: "a", name: "Old" })];
		const renameSession = vi.fn(async () => {});

		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ renameSession, showRenameHint: true, keybindings },
		);
		await flushPromises();

		selector.getSessionList().handleInput(CTRL_R);
		await flushPromises();

		// Rename mode layout
		const output = selector.render(120).join("\n");
		expect(output).toContain("Rename Session");
		expect(output).not.toContain("Resume Session");

		// Type and submit
		selector.handleInput("X");
		selector.handleInput("\r");
		await flushPromises();

		expect(renameSession).toHaveBeenCalledTimes(1);
		expect(renameSession).toHaveBeenCalledWith(sessions[0]!.path, "XOld");
	});

	// fork: a rename that fails is shown in the selector, never left to end the
	// process, and the next attempt works.
	it("shows a failed rename and lets the user try again", async () => {
		const sessions = [makeSession({ id: "a", name: "Old" })];
		const renameSession = vi
			.fn<(path: string, name: string | undefined) => Promise<void>>()
			.mockRejectedValueOnce(new Error("session file is gone"))
			.mockResolvedValueOnce(undefined);
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		try {
			const keybindings = new KeybindingsManager();
			const selector = new SessionSelectorComponent(
				async () => sessions,
				async () => [],
				() => {},
				() => {},
				() => {},
				() => {},
				{ renameSession, showRenameHint: true, keybindings },
			);
			await flushPromises();
			for (const _attempt of [1, 2]) {
				selector.getSessionList().handleInput(CTRL_R);
				await flushPromises();
				selector.handleInput("X");
				selector.handleInput("\r");
				await flushPromises();
				await flushPromises();
				if (_attempt === 1) expect(selector.render(120).join("\n")).toContain("session file is gone");
			}
			expect(renameSession).toHaveBeenCalledTimes(2);
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});
});
