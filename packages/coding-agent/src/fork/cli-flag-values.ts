/**
 * fork: the command line is parsed before extensions say which of their flags
 * are booleans, so a word after an unknown flag is taken as its value: `prism --some-boolean-flag "Summarize this repo"` would
 * lose the prompt. The word is remembered with its place among the messages, and when the flag turns out to be a
 * boolean it goes back there, before the initial message is built.
 */
import type { Args } from "../cli/args.ts";

interface AbsorbedValue {
	name: string;
	value: string;
	/** How many messages came before it. */
	index: number;
	released: boolean;
}

const absorbed = new WeakMap<Map<string, boolean | string>, { args: Args; values: AbsorbedValue[] }>();

/** Called by parseArgs when it takes the word after an unknown flag as that flag's value. */
export function recordAbsorbedValue(args: Args, name: string, value: string): void {
	let record = absorbed.get(args.unknownFlags);
	if (!record) {
		record = { args, values: [] };
		absorbed.set(args.unknownFlags, record);
	}
	record.values.push({ name, value, index: args.messages.length, released: false });
}

/**
 * Whether the command line may hold a message before extensions are loaded: a message, or a word taken as an unknown
 * flag's value, which is one when the flag is a boolean (`prism --some-boolean-flag "…"` counted as a plain launch and followed the window setting)
 * .
 */
export function mayHoldMessage(args: Args): boolean {
	return args.messages.length > 0 || (absorbed.get(args.unknownFlags)?.values.length ?? 0) > 0;
}

/** Puts back among the messages, in their place, the words taken as values of `name`, now known to be a boolean. */
export function releaseFlagValue(flags: Map<string, boolean | string>, name: string): void {
	const record = absorbed.get(flags);
	if (!record) return;
	for (const value of record.values) {
		if (value.name !== name || value.released) continue;
		const shift = record.values.filter((other) => other.released && other.index <= value.index).length;
		record.args.messages.splice(value.index + shift, 0, value.value);
		value.released = true;
	}
}
