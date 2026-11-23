/**
 * fork: a mistyped command (`/hepl`) went to the model as a
 * message and cost a turn. The terminal now refuses a `/name` that no command, prompt template or skill
 * answers to, and names the closest command. A first word that is an existing absolute path
 * (`/tmp is full`) is a message, not a command.
 */

import { existsSync } from "node:fs";
import { fill } from "./i18n/index.ts";

/** `/name` at the start of the message, up to a space or the end. */
const COMMAND_SHAPE = /^\/([A-Za-z][\w.:-]*)(?:\s|$)/;

function editDistance(a: string, b: string): number {
	const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		let diagonal = previous[0]!;
		previous[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const above = previous[j]!;
			previous[j] = Math.min(above + 1, previous[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
			diagonal = above;
		}
	}
	return previous[b.length]!;
}

/** The closest command name within two edits, or a command that starts with what was typed. */
export function closestCommand(name: string, commands: readonly string[]): string | undefined {
	const lower = name.toLowerCase();
	let best: { name: string; distance: number } | undefined;
	for (const command of commands) {
		const distance = editDistance(lower, command.toLowerCase());
		if (!best || distance < best.distance) best = { name: command, distance };
	}
	if (best && best.distance <= (lower.length >= 3 ? 2 : 1)) return best.name;
	return commands.find((command) => command.toLowerCase().startsWith(lower) && lower.length >= 2);
}

/**
 * The warning for a submitted `/name` that nothing answers to, or undefined when the text is a known
 * command, a path or not command-shaped. `pathExists` is injectable for tests.
 */
export function unknownCommandWarning(
	text: string,
	isKnown: (name: string) => boolean,
	commands: readonly string[],
	pathExists: (path: string) => boolean = existsSync,
): string | undefined {
	const match = COMMAND_SHAPE.exec(text);
	if (!match) return undefined;
	const name = match[1]!;
	if (isKnown(name)) return undefined;
	if (pathExists(`/${name}`)) return undefined;
	const closest = closestCommand(name, commands);
	return closest
		? fill("Unknown command /{0}. Did you mean /{1}? It was not sent to the model.", name, closest)
		: fill("Unknown command /{0}. Type / to see the commands. It was not sent to the model.", name);
}
