// fork: owner's decisions of 2026-11-05. Rarely needed commands leave the "/" list but still run when typed;
// /clone is the last entry of /fork.
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { createSessionAutocompleteProvider, UNLISTED_COMMANDS } from "../src/fork/autocomplete.ts";
import { FORK_WHOLE_CONVERSATION, FORK_WHOLE_DETAIL, FORK_WHOLE_LABEL } from "../src/fork/fork-whole.ts";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("fork: commands left out of the / list", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("leaves out /copy, /expand, /trace, /files, /sent and /clone, keeps the others", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					for (const name of ["trace", "files", "sent", "budget"])
						pi.registerCommand(name, { description: name, handler: async () => {} });
				},
			],
		});
		harnesses.push(harness);
		const provider = createSessionAutocompleteProvider({
			session: harness.session,
			settingsManager: harness.settingsManager,
			cwd: harness.tempDir,
			fdPath: undefined,
		});
		const suggestions = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
		const names = (suggestions?.items ?? []).map((item) => item.value.replace(/^\//, "").trim());
		for (const name of ["copy", "expand", "trace", "files", "sent", "clone"]) {
			expect(UNLISTED_COMMANDS.has(name)).toBe(true);
			expect(names).not.toContain(name);
		}
		for (const name of ["fork", "budget", "model", "settings"]) expect(names).toContain(name);
		// /hotkeys is gone, not only unlisted; /help lists the keys.
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "hotkeys")).toBe(false);
	});

	it("keeps a user's extension command of an unlisted name in the list", async () => {
		const harness = await createHarness({
			extensionFactories: [
				{
					path: "/home/me/.prism/agent/extensions/personal.ts",
					factory: (pi) => pi.registerCommand("sent", { description: "Personal sent", handler: async () => {} }),
				},
			],
		});
		harnesses.push(harness);
		const provider = createSessionAutocompleteProvider({
			session: harness.session,
			settingsManager: harness.settingsManager,
			cwd: harness.tempDir,
			fdPath: undefined,
		});
		const suggestions = await provider.getSuggestions(["/se"], 0, 3, { signal: new AbortController().signal });
		expect((suggestions?.items ?? []).map((item) => item.description)).toContainEqual(
			expect.stringContaining("Personal sent"),
		);
	});
});

describe("fork: /fork ends with the whole conversation", () => {
	it("labels the entry by what it copies, and counts only the messages", () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		let chosen: string | undefined;
		const selector = new UserMessageSelectorComponent(
			[
				{ id: "a", text: "first" },
				{ id: "b", text: "second" },
				{ id: FORK_WHOLE_CONVERSATION, text: FORK_WHOLE_LABEL, detail: `  ${FORK_WHOLE_DETAIL}` },
			],
			(id) => {
				chosen = id;
			},
			() => {},
			"b",
		);
		const text = selector.render(100).join("\n");
		expect(text).toContain("Message 2 of 2");
		expect(text).toContain(FORK_WHOLE_LABEL);
		expect(text).toContain(FORK_WHOLE_DETAIL);
		expect(text).not.toContain("of 3");
		// Down from the last message: the whole conversation.
		selector.getMessageList().handleInput("\x1b[B");
		selector.getMessageList().handleInput("\r");
		expect(chosen).toBe(FORK_WHOLE_CONVERSATION);
	});
});
