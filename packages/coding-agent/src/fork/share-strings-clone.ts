import { setOwn } from "./own.ts";

/**
 * fork.10 (RAM pass, gui-fork10.md § 56): a deep copy that shares strings. The extension runner copies the whole
 * conversation before each request so `context` handlers can edit it freely; `structuredClone` also copied every
 * text of it (tool outputs, files read), which was most of the engine's allocations in a long session. Strings
 * cannot be changed in place, so sharing them keeps that isolation: arrays and plain objects are copied, shared and
 * circular references stay shared and circular, anything else (Date, Map, typed arrays…) goes through
 * `structuredClone` as before.
 */
export function cloneSharingStrings<T>(value: T): T {
	return copy(value, new Map()) as T;
}

function copy(value: unknown, seen: Map<object, unknown>): unknown {
	if (value === null || typeof value !== "object") return value;
	const done = seen.get(value);
	if (done !== undefined) return done;
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		seen.set(value, out);
		for (const item of value) out.push(copy(item, seen));
		return out;
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) {
		const out = structuredClone(value);
		seen.set(value, out);
		return out;
	}
	const out: Record<string, unknown> = {};
	seen.set(value, out);
	// fork: `__proto__`, a valid JSON key, stays a key of the copy.
	for (const key of Object.keys(value)) setOwn(out, key, copy((value as Record<string, unknown>)[key], seen));
	return out;
}
