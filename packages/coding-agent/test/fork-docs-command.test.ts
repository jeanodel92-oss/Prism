// fork: /docs lists the shipped documentation and opens a topic; no deep paths in help.

import { type Component, type KeybindingsManager, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { getProviderLoginHelp } from "../src/core/auth-guidance.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
} from "../src/core/extensions/types.ts";
import { KeybindingsManager as AppKeybindings } from "../src/core/keybindings.ts";
import docsCommand, {
	DocReader,
	docTopics,
	findDocMatches,
	findTopic,
	matchTopics,
	pageQuery,
	prepareDocSearch,
	searchableTopics,
	topicExcerpt,
} from "../src/fork/docs-command.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("fork: /docs", () => {
	const topics = docTopics();
	beforeAll(() => initTheme("dark"));

	it("lists the topics of docs.json with their group", () => {
		expect(topics.length).toBeGreaterThan(10);
		expect(topics[0]).toEqual({ label: "Get Started › Overview", path: "index.md" });
		expect(topics.some((topic) => topic.path === "providers.md")).toBe(true);
	});

	it("finds a topic by file name or by words of its title", () => {
		expect(findTopic(topics, "providers")?.path).toBe("providers.md");
		expect(findTopic(topics, "permissions.md")?.path).toBe("permissions.md");
		expect(findTopic(topics, "choose model")?.path).toBe("models.md");
		expect(findTopic(topics, "")).toBeUndefined();
	});

	// fork.9 QA: what in a page answers the search shows before the page is opened.
	it("shows where a page holds the search, with the words underlined", () => {
		const lines = ["# Sessions", "", "You can **export** a session, and Export again.", "Nothing here."];
		const topic = {
			label: "Sessions",
			path: "sessions.md",
			text: lines.join("\n").toLowerCase(),
			lines: lines.map((line) => line.replace(/[#*`]/g, "").trim()),
			prepared: prepareDocSearch(lines.map((line) => line.replace(/[#*`]/g, "").trim())),
		};
		const excerpt = topicExcerpt(topic, "export") ?? "";
		expect(excerpt.startsWith("2× ")).toBe(true);
		expect(excerpt).toContain("\x1b[4mexport\x1b[24m");
		expect(topicExcerpt(topic, "sessionsmissing")).toBeUndefined();
		expect(topicExcerpt(topic, "")).toBeUndefined();
	});

	// /docs too long to read without a search.
	it("finds topics by words of their title first, then of their page, accents aside", () => {
		const searchable = searchableTopics(topics);
		const found = matchTopics(searchable, "firstKeptEntryId");
		expect(found.length).toBeGreaterThan(0);
		expect(found.length).toBeLessThan(topics.length);
		expect(found.every((topic) => !topic.label.toLowerCase().includes("firstkeptentryid"))).toBe(true);
		// A title match comes before page matches.
		const compaction = matchTopics(searchable, "compaction");
		expect(compaction[0]!.label.toLowerCase()).toContain("compaction");
		expect(compaction.length).toBeLessThan(topics.length);
		expect(matchTopics(searchable, "COMPÀCTION").map((topic) => topic.path)).toEqual(
			compaction.map((topic) => topic.path),
		);
		expect(matchTopics(searchable, "zzqx nowhere")).toEqual([]);
		expect(matchTopics(searchable, "  ")).toHaveLength(topics.length);
	});

	it("returns to the topic list after leaving a document and keeps it selected", async () => {
		const { selectedPaths, customCount } = await runDocsCommand("");

		expect(selectedPaths).toHaveLength(2);
		expect(selectedPaths[1]).toBe(selectedPaths[0]);
		expect(customCount).toBe(5);
	});

	it("opens the first topic found by typing in the list", async () => {
		const expected = matchTopics(searchableTopics(topics), "firstKeptEntryId")[0]!.path;
		expect(expected).not.toBe(topics[0]!.path);
		const { selectedPaths } = await runDocsCommand("", "firstKeptEntryId");
		expect(selectedPaths[0]).toBe(expected);
	});

	// maintainer's QA, 2026-11-05: the search says where the words are, in the list and in the page it opens.
	it("opens a page found by typing searched for the typed words", async () => {
		const { screens } = await runDocsCommand("", "firstKeptEntryId");
		expect(screens[0]).toContain("Search: firstKeptEntryId · match 1/");
		const topic = matchTopics(searchableTopics(topics), "firstKeptEntryId")[0]!;
		expect(pageQuery(topic, "firstKeptEntryId")).toBe("firstKeptEntryId");
		expect(pageQuery(topic, "zzqqxx firstKeptEntryId")).toBe("firstKeptEntryId");
		expect(pageQuery(topic, "zzqqxx")).toBe("");
		const { screens: unsearched } = await runDocsCommand("");
		expect(unsearched[0]).toContain("Type to search this page");
	});

	it("closes after leaving a document opened directly", async () => {
		const { customCount } = await runDocsCommand("overview");

		expect(customCount).toBe(1);
	});

	it("login help points at /login and /docs, not at file paths", () => {
		expect(getProviderLoginHelp()).toContain("/docs");
		expect(getProviderLoginHelp()).not.toMatch(/\.md\b|node_modules/);
	});
});

// "recherche dans le texte d'une page ouverte (Ctrl+F ou équivalent cohérent)".
describe("fork: search in the open /docs page", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new AppKeybindings({}));
	});

	it("finds a word in rendered lines, accents and case aside, in columns", () => {
		const lines = ["  \x1b[1mRéglages\x1b[22m and réglages", "日本 reglage", "nothing"];
		expect(findDocMatches(lines, "REGLAGE")).toEqual([
			{ row: 0, from: 2, to: 9 },
			{ row: 0, from: 15, to: 22 },
			// Wide characters take two columns each.
			{ row: 1, from: 5, to: 12 },
		]);
		expect(findDocMatches(lines, "  ")).toEqual([]);
	});

	const needleText = Array.from({ length: 40 }, (_, i) =>
		i % 10 === 5 ? `Paragraph ${i} mentions the needle here.` : `Paragraph ${i} is filler text.`,
	).join("\n\n");

	function reader(rows = 14) {
		const text = needleText;
		let closed = false;
		const view = new DocReader(
			"Title",
			text,
			() => rows,
			() => {
				closed = true;
			},
			() => {},
			"close",
		);
		const screen = () => view.render(80).map((line) => stripAnsi(line));
		const type = (keys: string) => {
			for (const key of [...keys]) view.handleInput(key);
		};
		return { view, screen, type, closed: () => closed };
	}

	it("typing searches the page, scrolls to the match and shows where it is among the others", () => {
		const { view, screen, type } = reader();
		expect(screen().at(-2)).toBe("Type to search this page");
		type("needle");
		let lines = screen();
		expect(lines.at(-2)).toBe("Search: needle · match 1/4");
		expect(lines.join("\n")).toContain("Paragraph 5 mentions the needle");
		const raw = view.render(80).join("\n");
		expect(raw).toContain("\x1b[7mneedle\x1b[27m");

		view.handleInput("\r");
		lines = screen();
		expect(lines.at(-2)).toBe("Search: needle · match 2/4");
		expect(lines.join("\n")).toContain("Paragraph 15 mentions");
		expect(lines.join("\n")).not.toContain("Paragraph 5 mentions");
		// Shift+Enter (kitty keyboard protocol) goes back; from the first match, to the last.
		view.handleInput("\x1b[13;2u");
		view.handleInput("\x1b[13;2u");
		expect(screen().at(-2)).toBe("Search: needle · match 4/4");
		view.handleInput("\r");
		expect(screen().at(-2)).toBe("Search: needle · match 1/4");
	});

	it("opened with a search, shows its first match", () => {
		const view = new DocReader(
			"Title",
			needleText,
			() => 14,
			() => {},
			() => {},
			"back",
			"needle",
		);
		const lines = view.render(80).map((line) => stripAnsi(line));
		expect(lines.at(-2)).toBe("Search: needle · match 1/4");
		expect(lines.join("\n")).toContain("Paragraph 5 mentions the needle");
		let closed = 0;
		const carried = new DocReader(
			"Title",
			needleText,
			() => 14,
			() => closed++,
			() => {},
			"back",
			"needle",
		);
		expect(stripAnsi(carried.render(80).at(-1)!)).toBe("Enter next · Shift+Enter previous · Esc back");
		carried.handleInput("\x1b");
		expect(closed, "Esc leaves at once: the reader did not type this search").toBe(1);
		const edited = new DocReader(
			"Title",
			needleText,
			() => 14,
			() => closed++,
			() => {},
			"back",
			"needle",
		);
		edited.render(80);
		edited.handleInput("s");
		edited.handleInput("\x1b");
		expect(closed, "once changed here, Esc clears it first").toBe(1);
	});

	it("starts from the page shown, reports no match, and Esc clears the search before closing", () => {
		const { view, screen, type, closed } = reader();
		view.handleInput("\x1b[6~");
		view.handleInput("\x1b[6~");
		const top = screen()[0];
		type("needle");
		expect(screen().at(-2)).not.toBe("Search: needle · match 1/4");
		expect(screen()[0]).not.toBe(top);
		type("zz");
		expect(screen().at(-2)).toBe("Search: needlezz · no match");
		view.handleInput("\x7f");
		view.handleInput("\x7f");
		expect(screen().at(-2)).toMatch(/^Search: needle · match \d\/4$/);
		view.handleInput("\x1b");
		expect(closed()).toBe(false);
		expect(screen().at(-2)).toBe("Type to search this page");
		view.handleInput("\x1b");
		expect(closed()).toBe(true);
	});
});

/** Runs /docs; pickers open the selected topic (typing `typed` first in the first one), readers are left with Esc. */
async function runDocsCommand(
	args: string,
	typed = "",
): Promise<{ selectedPaths: string[]; customCount: number; screens: string[] }> {
	const screens: string[] = [];
	let handler: RegisteredCommand["handler"] | undefined;
	docsCommand({
		registerCommand: (_name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			handler = command.handler;
		},
	} as unknown as ExtensionAPI);
	const selectedPaths: string[] = [];
	let customIndex = 0;
	const ctx = {
		hasUI: true,
		ui: {
			notify: () => {},
			custom: async <T>(
				factory: (
					tui: TUI,
					componentTheme: Theme,
					keybindings: KeybindingsManager,
					done: (result: T) => void,
				) => Component | Promise<Component>,
			) => {
				const index = customIndex++;
				return new Promise<T>((resolve) => {
					void Promise.resolve(
						factory(
							{ terminal: { rows: 30 }, requestRender: () => {} } as unknown as TUI,
							{} as Theme,
							{} as KeybindingsManager,
							resolve,
						),
					).then((component) => {
						if (!("handleInput" in component) || typeof component.handleInput !== "function") return;
						const chooseTopic = !args.trim() && index < 4 && index % 2 === 0;
						if (chooseTopic && index === 0) for (const character of typed) component.handleInput!(character);
						if (!chooseTopic) screens.push(stripAnsi(component.render(80).join("\n")));
						component.handleInput(chooseTopic ? "\r" : "\x1b");
					});
				}).then((result) => {
					if (typeof result === "string" && result) selectedPaths.push(result);
					return result;
				});
			},
		},
	} as unknown as ExtensionContext;
	await handler?.(args, ctx as ExtensionCommandContext);
	return { selectedPaths, customCount: customIndex, screens };
}
