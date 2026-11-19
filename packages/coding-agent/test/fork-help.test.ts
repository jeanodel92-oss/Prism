// fork: /help lists shortcuts and common actions, most frequent first, filterable.
import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { helpEntries, helpItems } from "../src/fork/help.ts";

const key = (id: string) => `<${id}>`;

describe("fork: /help", () => {
	it("is a built-in slash command", () => {
		expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).toEqual(expect.arrayContaining(["help", "expand"]));
	});

	it("puts what every session uses first", () => {
		const entries = helpEntries(key, () => true);
		expect(entries.slice(0, 4).map((entry) => entry.action)).toEqual([
			"Send the message",
			"New line in the message",
			"Stop the agent",
			"Commands",
		]);
		expect(entries[0].key).toBe("<tui.input.submit>");
		// Editing details come last.
		expect(entries.at(-1)?.action).toBe("Scroll by page");
	});

	it("lists extension commands only when their extension is loaded", () => {
		const all = helpEntries(key, () => true).map((entry) => entry.key);
		expect(all).toEqual(expect.arrayContaining(["/undo", "/perm"]));
		const none = helpEntries(key, () => false).map((entry) => entry.key);
		expect(none).not.toContain("/undo");
		expect(none).not.toContain("/perm");
	});

	it("drops shortcuts without a key and shows the detail next to the action", () => {
		const entries = helpEntries(
			(id) => (id === "app.suspend" ? "" : key(id)),
			() => true,
		);
		expect(entries.some((entry) => entry.action === "Suspend to the shell")).toBe(false);
		const items = helpItems(entries);
		expect(items[2]).toEqual({
			value: "2",
			label: "<app.interrupt>",
			description: "Stop the agent (also closes menus and autocomplete)",
		});
	});

	it("puts a command in the editor only for command entries", () => {
		const entries = helpEntries(key, () => true);
		expect(entries.find((entry) => entry.key === "/settings")?.command).toBe("/settings");
		expect(entries.find((entry) => entry.action === "Send the message")?.command).toBeUndefined();
	});
});
