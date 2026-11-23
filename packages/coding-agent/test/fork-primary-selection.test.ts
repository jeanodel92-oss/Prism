/**
 * fork: middle click pastes the primary selection in full screen, and a
 * selection Prism copies becomes the primary selection too.
 */
import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import {
	bracketedPaste,
	pastePrimarySelection,
	primaryCommands,
	readPrimarySelection,
	writePrimarySelection,
} from "../src/fork/primary-selection.ts";

describe.skipIf(platform() !== "linux")("fork: primary selection", () => {
	it("uses wl-paste/wl-copy under Wayland and xclip, then xsel, under X11", () => {
		expect(primaryCommands("read", { WAYLAND_DISPLAY: "wayland-0" })).toEqual([
			["wl-paste", ["--primary", "--no-newline"]],
		]);
		expect(primaryCommands("write", { DISPLAY: ":0" }).map(([command]) => command)).toEqual(["xclip", "xsel"]);
		expect(primaryCommands("read", {})).toEqual([]);
	});

	it("reads with the first tool that works, and writes the copied text", async () => {
		const calls: string[] = [];
		const text = await readPrimarySelection(
			async (command) => {
				calls.push(command);
				return command === "xsel" ? Buffer.from("picked") : undefined;
			},
			{ DISPLAY: ":0" },
		);
		expect(text).toBe("picked");
		expect(calls).toEqual(["xclip", "xsel"]);
		const written: Array<string | undefined> = [];
		await writePrimarySelection(
			"copied",
			async (_command, _args, options) => {
				written.push(options?.input);
				return Buffer.alloc(0);
			},
			{ WAYLAND_DISPLAY: "wayland-0" },
		);
		expect(written).toEqual(["copied"]);
	});

	it("pastes into the focused field as a bracketed paste, unless the focus moved meanwhile", async () => {
		const received: string[] = [];
		const field = { handleInput: (data: string) => received.push(data) };
		let focused: typeof field | undefined = field;
		let renders = 0;
		const ui = { getFocusedComponent: () => focused, requestRender: () => renders++ };
		await pastePrimarySelection(ui, async () => "hello");
		expect(received).toEqual([bracketedPaste("hello")]);
		expect(renders).toBe(1);
		await pastePrimarySelection(ui, async () => {
			focused = undefined;
			return "late";
		});
		expect(received).toHaveLength(1);
	});
});
