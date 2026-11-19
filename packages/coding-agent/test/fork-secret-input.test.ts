// fork: API keys typed or pasted in /login and /web-key are masked on screen.
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionInputComponent } from "../src/modes/interactive/components/extension-input.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

const TYPED = "sk-typed";
const PASTED = "PASTEDsecret0123456789abcdefghijklmnopqrstuvwxyz";
const KEY = TYPED + PASTED;

function enterKey(component: { handleInput(data: string): void }): void {
	for (const char of TYPED) component.handleInput(char);
	component.handleInput(`\x1b[200~${PASTED}\x1b[201~`);
}

function screen(component: { render(width: number): string[] }, width: number): string {
	return stripAnsi(component.render(width).join("\n"));
}

/** No run of 3+ characters of the key appears on screen. */
function expectHidden(text: string): void {
	for (let i = 0; i + 3 <= KEY.length; i++) expect(text).not.toContain(KEY.slice(i, i + 3));
}

describe("fork: secret input masking", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("masks an API key in the login dialog while typing, after a paste and once submitted", async () => {
		const dialog = new LoginDialogComponent({ requestRender: vi.fn() } as unknown as TUI, "p", () => {}, "P");
		const answer = dialog.showPrompt("Enter API key", undefined, true);
		enterKey(dialog);
		for (const width of [40, 64, 100]) {
			const text = screen(dialog, width);
			expectHidden(text);
			expect(text).toContain("•••");
		}
		dialog.handleInput("\r");
		await expect(answer).resolves.toBe(KEY);
		expectHidden(screen(dialog, 200));
	});

	it("still shows a non-secret prompt in clear", async () => {
		const dialog = new LoginDialogComponent({ requestRender: vi.fn() } as unknown as TUI, "p", () => {}, "P");
		void dialog.showPrompt("Enter API key", undefined, true);
		dialog.handleInput("\r");
		const answer = dialog.showPrompt("Name");
		for (const char of "local") dialog.handleInput(char);
		expect(screen(dialog, 100)).toContain("local");
		dialog.handleInput("\r");
		await expect(answer).resolves.toBe("local");
	});

	it("masks an extension input opened with { secret: true }", () => {
		let submitted: string | undefined;
		const input = new ExtensionInputComponent(
			"Exa API key",
			undefined,
			(value) => {
				submitted = value;
			},
			() => {},
			{ secret: true },
		);
		enterKey(input);
		for (const width of [40, 64, 100]) expectHidden(screen(input, width));
		input.handleInput("\r");
		expect(submitted).toBe(KEY);
	});
});
