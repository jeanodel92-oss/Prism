/**
 * fork: a confirmation applies only to the state it showed.
 *
 * `confirmCurrent(show, read)` reads the state, shows it, and reads it again at the answer. When its version (its
 * content or a fingerprint of it) is not the one shown, the question is asked again with the new state. After
 * `CONFIRM_CURRENT_ROUNDS` changes in a row, it gives up with `StateChangedError` rather than asking forever about a
 * state that never holds still (a file written continuously).
 */
import { t } from "./i18n/index.ts";

export const CONFIRM_CURRENT_ROUNDS = 3;

/** A state as `read` sees it: its value, and a version that changes whenever what the question shows changes. */
export interface CurrentState<T> {
	value: T;
	version: string;
}

export class StateChangedError extends Error {
	constructor(message = t("It changed during the question three times in a row; nothing was done.")) {
		super(message);
		this.name = "StateChangedError";
	}
}

/**
 * Asks `show` about the current state until the answer comes for a state that has not changed since.
 *
 * `show` receives the value to show and, when it is asked again because the state changed, the answer given about
 * the previous state; it returns the answer, or `undefined`, `null` or `false` for a refusal, which ends the question
 * without reading again. `apply`, when given, carries out the answer under the caller's own lock and returns false,
 * applying nothing, when the state is no longer the one shown: that counts as a change. The result is the answer with
 * the value it was given for, or `undefined` on a refusal; a value that changed `CONFIRM_CURRENT_ROUNDS` times in a
 * row throws `StateChangedError`.
 */
export async function confirmCurrent<T, A>(
	show: (value: T, previous: A | undefined) => Promise<A | undefined | null | false> | A | undefined | null | false,
	read: () => Promise<CurrentState<T>> | CurrentState<T>,
	options: {
		rounds?: number;
		changedMessage?: string;
		apply?: (value: T, version: string, answer: A) => Promise<boolean> | boolean;
	} = {},
): Promise<{ value: T; answer: A } | undefined> {
	const rounds = options.rounds ?? CONFIRM_CURRENT_ROUNDS;
	let shown = await read();
	let previous: A | undefined;
	for (let changes = 0; ; ) {
		const answer = await show(shown.value, previous);
		if (answer === undefined || answer === null || answer === false) return undefined;
		const now = await read();
		if (
			now.version === shown.version &&
			(!options.apply || (await options.apply(shown.value, shown.version, answer)))
		)
			return { value: shown.value, answer };
		changes += 1;
		if (changes >= rounds) throw new StateChangedError(options.changedMessage);
		shown = now.version === shown.version ? await read() : now;
		previous = answer;
	}
}
