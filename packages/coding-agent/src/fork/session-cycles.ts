/**
 * fork: a session whose entries' parents form a cycle is refused when it
 * is loaded. Every walk from an entry to the root follows `parentId` until there is none; a cycle (an entry its own
 * parent, or two entries each other's) made those walks endless, before the current session was even replaced.
 */

/** An entry from which following `parentId` comes back to an entry already passed, if any. Linear time. */
export function findParentCycle(
	byId: ReadonlyMap<string, { id: string; parentId: string | null }>,
): string | undefined {
	// Entries whose walk is known to reach a root or a missing parent.
	const ends = new Set<string>();
	for (const start of byId.keys()) {
		const walk = new Set<string>();
		let id: string | null | undefined = start;
		while (id && !ends.has(id)) {
			if (walk.has(id)) return id;
			walk.add(id);
			id = byId.get(id)?.parentId;
		}
		for (const passed of walk) ends.add(passed);
	}
	return undefined;
}

export function parentCycleError(id: string, file: string | undefined): Error {
	return new Error(`Session entries form a parent cycle at entry ${id}${file ? `: ${file}` : ""}`);
}
