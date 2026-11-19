/**
 * fork: permission globs matched by walking states, not by a
 * backtracking regex. `src/*a*a*…*a*b` against `src/aaa…ac` made V8 try every way of sharing the a's between the
 * stars before failing: 14 stars on 30 characters took 6.8 s on the engine's thread. Here each character moves a
 * set of positions in the pattern, so the work is at most the text's length times the pattern's.
 *
 * Same syntax and meaning as the former regex, on UTF-16 code units:
 * - path glob (loose = false): `*` is any run without "/", `**` any run, `?` one character but "/";
 * - command pattern (loose = true): `*` is any run and `?` one character, neither crossing a line break
 *   (`\n`, `\r`, U+2028, U+2029), so `git *` does not cover a second command.
 */

interface GlobStep {
	/** Repeats any number of times (a star), or matches exactly one character. */
	star: boolean;
	/** The literal code unit, or -1 for a wildcard. */
	code: number;
	/** What a wildcard does not match. */
	stop: "slash" | "line" | "none";
}

const SLASH = 47;

const isLineBreak = (code: number) => code === 10 || code === 13 || code === 0x2028 || code === 0x2029;

function compile(glob: string, loose: boolean): GlobStep[] {
	const steps: GlobStep[] = [];
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index];
		if (char === "*") {
			if (loose) steps.push({ star: true, code: -1, stop: "line" });
			else if (glob[index + 1] === "*") {
				steps.push({ star: true, code: -1, stop: "none" });
				index++;
			} else steps.push({ star: true, code: -1, stop: "slash" });
		} else if (char === "?") steps.push({ star: false, code: -1, stop: loose ? "line" : "slash" });
		else steps.push({ star: false, code: glob.charCodeAt(index), stop: "none" });
	}
	return steps;
}

function accepts(step: GlobStep, code: number): boolean {
	if (step.code >= 0) return code === step.code;
	if (step.stop === "slash") return code !== SLASH;
	if (step.stop === "line") return !isLineBreak(code);
	return true;
}

function matches(steps: GlobStep[], text: string): boolean {
	const end = steps.length;
	// stamp[state] says at which position the state was last added, so it is added once per position.
	const stamp = new Int32Array(end + 1);
	let states = new Int32Array(end + 1);
	let following = new Int32Array(end + 1);
	const add = (into: Int32Array, size: number, from: number, mark: number): number => {
		// A star may match nothing: the position after it is reached as well.
		for (let state = from; stamp[state] !== mark; state++) {
			stamp[state] = mark;
			into[size++] = state;
			if (state === end || !steps[state].star) break;
		}
		return size;
	};
	let count = add(states, 0, 0, 1);
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		const mark = index + 2;
		let size = 0;
		for (let k = 0; k < count; k++) {
			const state = states[k];
			if (state === end || !accepts(steps[state], code)) continue;
			size = add(following, size, steps[state].star ? state : state + 1, mark);
		}
		if (size === 0) return false;
		[states, following] = [following, states];
		count = size;
	}
	for (let k = 0; k < count; k++) if (states[k] === end) return true;
	return false;
}

const cache = new Map<string, GlobStep[]>();

/** Whether `text` matches the whole of `glob`. */
export function globMatches(glob: string, loose: boolean, text: string): boolean {
	const key = (loose ? "l:" : "p:") + glob;
	let steps = cache.get(key);
	if (!steps) {
		steps = compile(glob, loose);
		cache.set(key, steps);
	}
	return matches(steps, text);
}
