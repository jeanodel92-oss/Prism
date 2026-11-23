/**
 * fork: Linux terminals paste the primary selection on a middle click, but
 * full screen captures the mouse, so the terminal never sees that click. Prism reads the primary selection itself and
 * pastes it into the focused field, and a selection it copies also becomes the primary selection, so selecting in the
 * transcript then middle-clicking in the editor works as in any terminal.
 */

import { platform } from "node:os";
import { runClipboardCommand } from "../utils/clipboard-command.ts";

type Command = readonly [string, readonly string[]];

/** The commands that read (or write) the primary selection here, in order of preference. */
export function primaryCommands(mode: "read" | "write", env: NodeJS.ProcessEnv = process.env): Command[] {
	const commands: Command[] = [];
	if (env.WAYLAND_DISPLAY) {
		commands.push(mode === "read" ? ["wl-paste", ["--primary", "--no-newline"]] : ["wl-copy", ["--primary"]]);
	}
	if (env.DISPLAY) {
		commands.push(
			mode === "read" ? ["xclip", ["-selection", "primary", "-out"]] : ["xclip", ["-selection", "primary"]],
			mode === "read" ? ["xsel", ["--primary", "--output"]] : ["xsel", ["--primary", "--input"]],
		);
	}
	return commands;
}

/** The primary selection's text, or undefined when there is none or no tool can read it. */
export async function readPrimarySelection(
	run: typeof runClipboardCommand = runClipboardCommand,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
	if (platform() !== "linux") return undefined;
	for (const [command, args] of primaryCommands("read", env)) {
		const bytes = await run(command, args, { timeoutMs: 2000, maxBufferBytes: 10 * 1024 * 1024 });
		if (bytes !== undefined) return bytes.toString("utf8") || undefined;
	}
	return undefined;
}

/** Make `text` the primary selection too; best effort, silent when no tool can. */
export async function writePrimarySelection(
	text: string,
	run: typeof runClipboardCommand = runClipboardCommand,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	if (platform() !== "linux") return;
	for (const [command, args] of primaryCommands("write", env)) {
		if ((await run(command, args, { input: text, timeoutMs: 2000 })) !== undefined) return;
	}
}

/** What a field receives for a paste: the text in bracketed-paste markers, like a terminal's own paste. */
export function bracketedPaste(text: string): string {
	return `\x1b[200~${text}\x1b[201~`;
}

interface PasteTarget {
	getFocusedComponent(): { handleInput?(data: string): void } | null | undefined;
	requestRender(): void;
}

/** Paste the primary selection into the focused field, if it is still focused once the selection is read. */
export async function pastePrimarySelection(
	ui: PasteTarget,
	read: () => Promise<string | undefined> = () => readPrimarySelection(),
): Promise<void> {
	const target = ui.getFocusedComponent();
	if (!target?.handleInput) return;
	const text = await read();
	if (!text || ui.getFocusedComponent() !== target) return;
	target.handleInput(bracketedPaste(text));
	ui.requestRender();
}
