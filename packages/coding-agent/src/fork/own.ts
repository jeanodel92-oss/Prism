/**
 * fork: a dictionary keyed by names that come from outside (a tool, a
 * server, a form field, a variable, a word to translate). A plain object answers `constructor`, `toString` or
 * `__proto__` with what every object inherits, and an assignment to `__proto__` changes the prototype instead of
 * storing a value; these two read and write the object's own data only.
 */

/** The value stored under `key`, never one every object inherits. */
export function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Stores `value` under `key` as data, `__proto__` included. */
export function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}
