/**
 * the model uses a key it never reads. It writes the label
 * `[secret hidden: NAME]` of a key Prism knows into a command or a file; Prism asks the user each time (this time,
 * until the end of the session, or always for this program: a `passEnv` rule), then puts the key in at execution
 * only. The call's arguments keep the label, so the session, the permission gate, the other extensions and the
 * interface never hold the key; what the command prints stays masked (tool_result, extension.ts).
 *
 * The key goes in by the call's id: the bash operations (`withoutSecrets`), the background task, `write` and `edit`
 * each ask {@link revealSecrets} for the text they run or write. `edit` matches its `oldText` against the file with the
 * approved keys shown as their labels ({@link hideSecrets}), so a label the model copied from a masked read matches.
 */

import { type Secrets, secretLabel } from "./mask.ts";

const LABEL = /\[secret hidden: ([^\]\n]+)\]/g;

/**
 * A key in a command goes in as typed, so a key a shell would read differently (a quote, a space, `$`) is not put in
 * a command: it would break the command or run part of the key.
 */
const COMMAND_SAFE = /^[\w.~+/=:@%,-]+$/;

/** The names of the labels in `texts`, each once, in order. */
export function labelNames(texts: readonly string[]): string[] {
	const names = new Set<string>();
	for (const text of texts) for (const match of text.matchAll(LABEL)) names.add(match[1]!);
	return [...names];
}

export type LabelProblem = "several keys" | "unsafe in a command";

export interface LabelLookup {
	/** Name to its key, for the names that name exactly one known key. */
	keys: Map<string, string>;
	/** Names Prism cannot put in, with why. Names of no known key are in neither: their label stays as written. */
	problems: Map<string, LabelProblem>;
}

/** The keys behind `names`. A name shared by several keys (an OAuth access and refresh token) is refused. */
export function lookUpLabels(names: readonly string[], secrets: Secrets, inCommand: boolean): LabelLookup {
	const values = new Map<string, string[]>();
	for (const [value, name] of secrets) values.set(name, [...(values.get(name) ?? []), value]);
	const result: LabelLookup = { keys: new Map(), problems: new Map() };
	for (const name of names) {
		const found = values.get(name) ?? [];
		if (found.length === 0) continue;
		if (found.length > 1) result.problems.set(name, "several keys");
		else if (inCommand && !COMMAND_SAFE.test(found[0]!)) result.problems.set(name, "unsafe in a command");
		else result.keys.set(name, found[0]!);
	}
	return result;
}

/** Call id to the keys the user let it use, by name. */
const approved = new Map<string, Map<string, string>>();

/** Lets the call `toolCallId` use these keys (name to key), once the user said yes. */
export function approveReveal(toolCallId: string, keys: ReadonlyMap<string, string>): void {
	approved.set(toolCallId, new Map(keys));
}

/** Forgets what the call was let use: it ended, or the session did. */
export function forgetReveal(toolCallId?: string): void {
	if (toolCallId === undefined) approved.clear();
	else approved.delete(toolCallId);
}

/** `text` with the labels of the keys this call may use replaced by the keys. Unchanged for any other call. */
export function revealSecrets(toolCallId: string | undefined, text: string): string {
	const keys = toolCallId === undefined ? undefined : approved.get(toolCallId);
	if (!keys) return text;
	return text.replace(LABEL, (label, name: string) => keys.get(name) ?? label);
}

/** `text` with the keys this call may use replaced by their labels: what the model saw of the file. */
export function hideSecrets(toolCallId: string | undefined, text: string): string {
	const keys = toolCallId === undefined ? undefined : approved.get(toolCallId);
	if (!keys) return text;
	let hidden = text;
	for (const [name, key] of [...keys].sort((a, b) => b[1].length - a[1].length)) {
		hidden = hidden.split(key).join(secretLabel(name));
	}
	return hidden;
}
