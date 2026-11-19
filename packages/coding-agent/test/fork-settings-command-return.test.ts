import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// fork: /settings > "Modes and permissions in effect" opened /perm window, and Esc there
// closed everything instead of coming back to /settings.

type Context = {
	session: {
		extensionRunner: { getCommand: (name: string) => unknown };
		isStreaming: boolean;
		prompt: (text: string) => Promise<void>;
	};
	extensionWindowsOpened: number;
	settingsOpened: number;
	editor: { getText(): string; setText(text: string): void };
	submitCommandLine: ReturnType<typeof vi.fn>;
	showSettingsSelector: ReturnType<typeof vi.fn>;
	isExtensionCommand(text: string): boolean;
};

type Prototype = {
	runSettingsCommand(this: Context, command: string, from?: { domain: string; item: string }): Promise<void>;
	isExtensionCommand(this: Context, text: string): boolean;
};

const prototype = InteractiveMode.prototype as unknown as Prototype;
const from = { domain: "permissions", item: "command:perm window" };

/** A session whose extension command "perm" opens a window, or only writes to the conversation. */
function context(opensWindow: boolean, startsTurn = false, opensSettings = false, fillsInput = false): Context {
	let input = "";
	const ctx: Context = {
		session: {
			extensionRunner: { getCommand: (name) => (name === "perm" ? { name } : undefined) },
			isStreaming: false,
			prompt: vi.fn(async () => {
				if (opensWindow) ctx.extensionWindowsOpened++;
				if (startsTurn) ctx.session.isStreaming = true;
				if (opensSettings) ctx.settingsOpened++;
				if (fillsInput) ctx.editor.setText("!npm install -g @biomejs/biome");
			}),
		},
		extensionWindowsOpened: 0,
		settingsOpened: 0,
		editor: {
			getText: () => input,
			setText: (text) => {
				input = text;
			},
		},
		submitCommandLine: vi.fn(async () => {}),
		showSettingsSelector: vi.fn(async () => {}),
		isExtensionCommand: (text) => prototype.isExtensionCommand.call(ctx, text),
	};
	return ctx;
}

describe("a command chosen in /settings", () => {
	it("comes back to /settings, on its row, once the window it opened is closed", async () => {
		const ctx = context(true);
		await prototype.runSettingsCommand.call(ctx, "perm window", from);
		expect(ctx.session.prompt).toHaveBeenCalledWith("/perm window");
		expect(ctx.showSettingsSelector).toHaveBeenCalledWith("permissions", "command:perm window");
	});

	it("leaves the conversation shown when it only wrote to it", async () => {
		const ctx = context(false);
		await prototype.runSettingsCommand.call(ctx, "perm status", from);
		expect(ctx.showSettingsSelector).not.toHaveBeenCalled();
	});

	it("leaves the conversation shown when it started a turn", async () => {
		const ctx = context(true, true);
		await prototype.runSettingsCommand.call(ctx, "perm window", from);
		expect(ctx.showSettingsSelector).not.toHaveBeenCalled();
	});

	// fork: "Saved rules" in /perm window opens /settings on the rules; a second /settings
	// on the window's row would cover them.
	it("does not open /settings again when the command opened it on another row", async () => {
		const ctx = context(true, false, true);
		await prototype.runSettingsCommand.call(ctx, "perm window", from);
		expect(ctx.showSettingsSelector).not.toHaveBeenCalled();
	});

	// fork: /lsp-setup puts an install command in the input box; /settings would cover it.
	it("leaves the input box shown when the command put a command in it", async () => {
		const ctx = context(true, false, false, true);
		await prototype.runSettingsCommand.call(ctx, "perm window", from);
		expect(ctx.showSettingsSelector).not.toHaveBeenCalled();
	});

	it("still runs a built-in command through the composer's submit path", async () => {
		const ctx = context(true);
		await prototype.runSettingsCommand.call(ctx, "scoped-models", {
			domain: "models",
			item: "command:scoped-models",
		});
		expect(ctx.submitCommandLine).toHaveBeenCalledWith("/scoped-models");
		expect(ctx.session.prompt).not.toHaveBeenCalled();
		expect(ctx.showSettingsSelector).not.toHaveBeenCalled();
	});
});
