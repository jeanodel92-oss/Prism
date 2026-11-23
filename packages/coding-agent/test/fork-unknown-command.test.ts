// fork: a mistyped /command is refused, not sent to the model.
import { describe, expect, test } from "vitest";
import { closestCommand, unknownCommandWarning } from "../src/fork/unknown-command.ts";

const commands = ["help", "model", "settings", "compact", "quit", "skill:review"];
const isKnown = (name: string) => commands.includes(name);
const noPath = () => false;

describe("unknown slash commands", () => {
	test("refuses a typo and names the closest command", () => {
		expect(unknownCommandWarning("/hepl", isKnown, commands, noPath)).toBe(
			"Unknown command /hepl. Did you mean /help? It was not sent to the model.",
		);
		expect(unknownCommandWarning("/setings dark", isKnown, commands, noPath)).toContain("Did you mean /settings?");
	});

	test("refuses an unknown name with no close command", () => {
		expect(unknownCommandWarning("/zzz", isKnown, commands, noPath)).toBe(
			"Unknown command /zzz. Type / to see the commands. It was not sent to the model.",
		);
	});

	test("lets known commands, paths and ordinary messages through", () => {
		expect(unknownCommandWarning("/help", isKnown, commands, noPath)).toBeUndefined();
		expect(unknownCommandWarning("/skill:review the diff", isKnown, commands, noPath)).toBeUndefined();
		expect(unknownCommandWarning("/tmp is full, why?", isKnown, commands, (path) => path === "/tmp")).toBeUndefined();
		expect(unknownCommandWarning("/etc/fstab looks wrong", isKnown, commands, noPath)).toBeUndefined();
		expect(unknownCommandWarning("hello /hepl", isKnown, commands, noPath)).toBeUndefined();
		expect(unknownCommandWarning("/ 2 + 2", isKnown, commands, noPath)).toBeUndefined();
	});

	test("suggests by prefix when the name is cut short", () => {
		expect(closestCommand("comp", commands)).toBe("compact");
		expect(closestCommand("x", commands)).toBeUndefined();
	});
});
