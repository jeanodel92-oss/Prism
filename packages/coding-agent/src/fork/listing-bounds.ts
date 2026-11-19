/**
 * fork: find and ls stop collecting at their limit.
 *
 * - `find` with `limit: 0` ran fd with `--max-results 0`, which fd reads as "no limit", and gathered every
 *   path before cutting the answer to 50 KB. A limit is now a whole number of at least 1, refused otherwise.
 * - `ls` read a whole folder into one array and sorted it before keeping `limit` entries. The local folder
 *   is now read entry by entry, keeping only the first entries in the listing's order ({@link firstSorted}).
 */
import { opendir } from "node:fs/promises";
import { DEFAULT_MAX_BYTES } from "../core/tools/truncate.ts";

/** `limit` checked: undefined gives `fallback`; anything but a whole number of at least 1 is refused. */
export function wholeLimit(limit: number | undefined, fallback: number): number {
	if (limit === undefined) return fallback;
	if (!Number.isInteger(limit) || limit < 1)
		throw new Error(`limit must be a whole number of at least 1, got ${limit}`);
	return limit;
}

/**
 * The most names worth keeping: one more than the output budget can show at two bytes a line (a name and its newline),
 * so a listing cut here is still marked as cut by the byte limit.
 */
export const MAX_KEPT_NAMES = Math.floor(DEFAULT_MAX_BYTES / 2) + 1;

const collator = new Intl.Collator();
/** ls's order: case-insensitive, `localeCompare` (the default collator), ties kept in reading order. */
function before(a: { key: string; index: number }, b: { key: string; index: number }): boolean {
	const order = collator.compare(a.key, b.key);
	return order < 0 || (order === 0 && a.index < b.index);
}

/**
 * The first `keep` names of `names` in ls's order, holding at most `keep` of them at a time (a heap of the best so far),
 * and whether any were left out. `signal` is checked as the names arrive.
 */
export async function firstSorted(
	names: AsyncIterable<string> | Iterable<string>,
	keep: number,
	signal?: AbortSignal,
): Promise<{ names: string[]; more: boolean }> {
	// A max-heap: its root is the last of the names kept, the one a better name replaces.
	const heap: Array<{ name: string; key: string; index: number }> = [];
	let index = 0;
	const down = (at: number) => {
		for (;;) {
			const left = 2 * at + 1;
			const right = left + 1;
			let last = at;
			if (left < heap.length && before(heap[last], heap[left])) last = left;
			if (right < heap.length && before(heap[last], heap[right])) last = right;
			if (last === at) return;
			[heap[at], heap[last]] = [heap[last], heap[at]];
			at = last;
		}
	};
	const up = (at: number) => {
		while (at > 0) {
			const parent = (at - 1) >> 1;
			if (!before(heap[parent], heap[at])) return;
			[heap[at], heap[parent]] = [heap[parent], heap[at]];
			at = parent;
		}
	};
	for await (const name of names) {
		if (index % 1024 === 0 && signal?.aborted) throw new Error("Operation aborted");
		const item = { name, key: name.toLowerCase(), index: index++ };
		if (heap.length < keep) {
			heap.push(item);
			up(heap.length - 1);
		} else if (keep > 0 && before(item, heap[0])) {
			heap[0] = item;
			down(0);
		}
	}
	const sorted = heap.sort((a, b) => (before(a, b) ? -1 : 1)).map((item) => item.name);
	return { names: sorted, more: index > keep };
}

/** A local folder's names, read entry by entry; the folder is closed when the reading stops. */
export async function* localNames(path: string): AsyncGenerator<string> {
	for await (const entry of await opendir(path, { bufferSize: 256 })) yield entry.name;
}
