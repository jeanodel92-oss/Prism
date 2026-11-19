// fork: typed aliases run the command they stand for, never over a real command.
import { describe, expect, it } from "vitest";
import { resolveCommandAlias } from "../src/fork/command-aliases.ts";

describe("fork: command aliases", () => {
	const exists = (names: string[]) => (name: string) => names.includes(name);

	it("maps an alias to its command", () => {
		expect(resolveCommandAlias("exit", exists(["quit"]))).toBe("quit");
		expect(resolveCommandAlias("config", exists(["settings"]))).toBe("settings");
	});

	it("leaves real commands, unknown words and aliases of missing commands alone", () => {
		expect(resolveCommandAlias("quit", exists(["quit"]))).toBeUndefined();
		expect(resolveCommandAlias("exit", exists(["quit", "exit"]))).toBeUndefined();
		expect(resolveCommandAlias("nothing", exists(["quit"]))).toBeUndefined();
		expect(resolveCommandAlias("documentation", exists(["quit"]))).toBeUndefined();
	});
});
