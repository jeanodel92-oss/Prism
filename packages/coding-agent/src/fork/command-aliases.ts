// fork: other words that find a command in the "/" list, and that run it when typed in
// full. The "/" search matched literal names only: "exit" found nothing, "quit" did
// . Aliases never shadow a real command of the same name.

import { own } from "./own.ts";

export const COMMAND_ALIASES: Record<string, string[]> = {
	quit: ["exit", "close", "bye", "leave"],
	settings: ["config", "configure", "preferences", "options", "setup"],
	help: ["commands", "keys", "shortcuts"],
	docs: ["documentation", "manual", "guide", "readme"],
	model: ["llm", "provider"],
	new: ["clear", "reset", "restart"],
	resume: ["open", "history", "sessions"],
	login: ["connect", "signin", "auth", "server"],
	logout: ["signout", "disconnect"],
	perm: ["permissions", "yolo", "unrestricted", "safe"],
	thinking: ["reasoning", "effort", "think"],
	compact: ["summarize", "shrink"],
	export: ["save", "html"],
	copy: ["clipboard"],
	expand: ["collapse", "fold", "unfold"],
	reload: ["refresh"],
};

/** The command a fully typed alias stands for, unless a command of that name exists. */
export function resolveCommandAlias(name: string, exists: (name: string) => boolean): string | undefined {
	if (exists(name)) return undefined;
	for (const [command, aliases] of Object.entries(COMMAND_ALIASES)) {
		if (aliases.includes(name) && exists(command)) return command;
	}
	return undefined;
}

// Fork.9 QA: the commands people reach for first head the "/" list; the rest keep their order. Typing still searches
// everything.
const COMMAND_ORDER = [
	"new",
	"resume",
	"model",
	"thinking",
	"settings",
	"perm",
	"sandbox",
	"plan",
	"goal",
	"budget",
	"bg",
	"context",
	"compact",
	"tree",
	"init",
	"docs",
	"help",
	"doctor",
];

/** `commands` with the most used first (`COMMAND_ORDER`), the others after them in the same order. */
export function byCommandOrder<T extends { name: string }>(commands: T[]): T[] {
	const rank = (command: T) => {
		const index = COMMAND_ORDER.indexOf(command.name);
		return index === -1 ? COMMAND_ORDER.length : index;
	};
	return [...commands].sort((a, b) => rank(a) - rank(b));
}

/** The aliases of a command; undefined for a command without any. */
export function commandAliases(name: string): string[] | undefined {
	return own(COMMAND_ALIASES, name);
}
