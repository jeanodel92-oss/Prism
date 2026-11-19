/**
 * fork: the one masking of the secret values Prism knows (`knownSecrets`, env.ts), for each
 * copy that leaves Prism: the request to the model, the session, the files Prism writes, the exports and shares.
 *
 * It works on the decoded value, never on its serialized text. A key `ab"cd` is `ab\"cd` inside JSON, which a search
 * for `ab"cd` in `JSON.stringify(...)` misses: the caller masks the structure, then serializes the copy. A
 * text that was never a structure (a command's output) is searched for each secret and for its JSON-escaped form, in
 * case it prints JSON. Nothing here reads a file, a setting or the keyring.
 */

import { Transform } from "node:stream";

/** Secret value to what it is (a variable's name, `auth.json <provider>`). */
export type Secrets = ReadonlyMap<string, string>;

export const secretLabel = (name: string): string => `[secret hidden: ${name}]`;

/** Counts the replacements, for an export that says how many it made. */
export interface MaskCount {
	replaced: number;
}

interface Form {
	value: string;
	label: string;
}

const formsCache = new WeakMap<Secrets, Form[]>();

/** Each secret and, when it differs, its form inside a JSON string; longest first, so a key that holds another goes whole. */
function forms(secrets: Secrets): Form[] {
	let list = formsCache.get(secrets);
	if (!list) {
		list = [];
		for (const [value, name] of secrets) {
			const label = secretLabel(name);
			list.push({ value, label });
			const escaped = JSON.stringify(value).slice(1, -1);
			if (escaped !== value) list.push({ value: escaped, label });
		}
		list.sort((a, b) => b.value.length - a.value.length);
		formsCache.set(secrets, list);
	}
	return list;
}

function replaceForms(text: string, list: readonly Form[], count?: MaskCount): string {
	let masked = text;
	for (const { value, label } of list) {
		if (!masked.includes(value)) continue;
		const parts = masked.split(value);
		if (count) count.replaced += parts.length - 1;
		masked = parts.join(label);
	}
	return masked;
}

/** `text` with each known secret, raw or JSON-escaped, replaced by its label. */
export function maskText(text: string, secrets: Secrets, count?: MaskCount): string {
	return secrets.size ? replaceForms(text, forms(secrets), count) : text;
}

/** Field names a secret is kept under: `apiKey`, `sessionToken`, `client_secret`, `X_PASSWORD`, `Authorization`… */
const SECRET_NAME = /(?:^|[-_])(?:api[-_]?key|secret|token|password|passwd|credential|authorization|cookie)(?:$|[-_])/i;

/**
 * Whether a field or a URL parameter holds a secret by its name, whatever its value: `authToken`, `xPassword`,
 * `access_token`. Plural counts such as `maxTokens` stay readable. The one list of such names.
 */
export function secretName(key: string): boolean {
	return SECRET_NAME.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

/** Identifiers and signatures, which must reach the provider or the session exactly: never searched. */
const KEPT_FIELDS = new Set(["id", "parentId", "toolCallId", "textSignature", "thinkingSignature", "thoughtSignature"]);
/** A provider checks these against the content they sign: a block the mask changes loses them. */
const SIGNATURES = ["thinkingSignature", "thoughtSignature"];

export interface MaskOptions {
	count?: MaskCount;
	/** Also replace the value of each field whose name holds a secret ({@link secretName}) by this text. */
	byName?: string;
	/** Applied to each string after the known secrets are masked (patterns of keys Prism does not know). */
	text?: (text: string) => string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * A copy of a decoded value with each known secret masked in every string and every property name. Two names
 * that become the same are told apart by `#2`, `#3`. The value itself is returned when nothing changes, so the caller
 * can tell. Images' data and the fields of {@link KEPT_FIELDS} are left as they are; an object that is not plain data
 * (a class instance, a buffer) too.
 */
export function maskValue<T>(value: T, secrets: Secrets, options: MaskOptions = {}): T {
	const list = forms(secrets);
	if (list.length === 0 && options.byName === undefined && !options.text) return value;
	// An object met twice gets the same copy; one met inside itself (a cycle) is left as it is.
	const copies = new WeakMap<object, unknown>();
	const text = (input: string) => {
		const masked = list.length ? replaceForms(input, list, options.count) : input;
		return options.text ? options.text(masked) : masked;
	};
	const visit = (input: unknown): unknown => {
		if (typeof input === "string") return text(input);
		if (typeof input !== "object" || input === null) return input;
		if (copies.has(input)) return copies.get(input);
		copies.set(input, input);
		const copy = visitObject(input);
		copies.set(input, copy);
		return copy;
	};
	const visitObject = (input: object): unknown => {
		if (Array.isArray(input)) {
			let changed = false;
			const copy = input.map((entry) => {
				const masked = visit(entry);
				if (masked !== entry) changed = true;
				return masked;
			});
			return changed ? copy : input;
		}
		if (!isPlainObject(input)) return input;
		const image = input.type === "image";
		let changed = false;
		const entries: [string, unknown][] = [];
		const names = new Set<string>();
		for (const [key, entry] of Object.entries(input)) {
			let name = text(key);
			if (name !== key) {
				changed = true;
				for (let n = 2; names.has(name) || (name !== key && Object.hasOwn(input, name)); n++)
					name = `${text(key)}#${n}`;
			}
			names.add(name);
			let masked: unknown = entry;
			if (KEPT_FIELDS.has(key) || (image && key === "data")) masked = entry;
			else if (options.byName !== undefined && entry !== null && entry !== undefined && secretName(key))
				masked = options.byName;
			else masked = visit(entry);
			if (masked !== entry) changed = true;
			entries.push([name, masked]);
		}
		if (!changed) return input;
		const copy: Record<string, unknown> = Object.getPrototypeOf(input) === null ? Object.create(null) : {};
		for (const [name, entry] of entries) {
			if (SIGNATURES.includes(name)) continue;
			// `__proto__` from outside data stays a plain field.
			Object.defineProperty(copy, name, { value: entry, enumerable: true, writable: true, configurable: true });
		}
		return copy;
	};
	return visit(value) as T;
}

/**
 * The request to the model with the known secrets masked in its system prompt, its tools and every message but the
 * model's own. Those came from the model, so masking them protects nothing; and a reasoning block changed under its
 * signature makes the provider refuse every later request.
 */
export function maskModelContext<
	C extends { systemPrompt?: string; messages: readonly { role: string }[]; tools?: readonly unknown[] },
>(context: C, secrets: Secrets): C {
	if (secrets.size === 0) return context;
	const messages = context.messages.map((message) =>
		message.role === "assistant" ? message : maskValue(message, secrets),
	);
	return {
		...context,
		...(context.systemPrompt === undefined ? {} : { systemPrompt: maskText(context.systemPrompt, secrets) }),
		messages,
		...(context.tools === undefined ? {} : { tools: maskValue(context.tools, secrets) }),
	};
}

/**
 * A byte stream with each known secret replaced by its label, for output written or shown while a command runs. The
 * end that may still become a secret is held back until the next chunk or `end()`. Held on the raw bytes, so that a
 * short secret is only replaced once no longer secret can still extend it: `tok_ABC` then `_PRIVATE` is the
 * longer `tok_ABC_PRIVATE`, never `[secret hidden: SHORT]_PRIVATE`.
 */
export function maskingStream(
	secrets: Secrets,
	emit: (data: Buffer) => void,
): { write: (data: Buffer) => void; end: () => void } {
	// Bytes as latin1 text, one character per byte: a secret split inside a UTF-8 character is still found.
	const latin1 = (text: string) => Buffer.from(text).toString("latin1");
	const list = forms(secrets).map(({ value, label }) => ({ value: latin1(value), label: latin1(label) }));
	const keep = Math.max(0, ...list.map(({ value }) => value.length - 1));
	// Where the bytes that are certainly not part of a secret end.
	const safeEnd = (raw: string) => {
		let cut = raw.length;
		// The longest end, at most `keep` bytes, that a secret begins with.
		for (let start = Math.max(0, raw.length - keep); start < raw.length; start++) {
			const end = raw.slice(start);
			if (list.some(({ value }) => value.startsWith(end))) {
				cut = start;
				break;
			}
		}
		// A whole secret that starts before the cut and ends after it is held whole.
		for (let moved = true; moved; ) {
			moved = false;
			for (const { value } of list) {
				const at = raw.indexOf(value, Math.max(0, cut - value.length + 1));
				if (at !== -1 && at < cut && at + value.length > cut) {
					cut = at;
					moved = true;
				}
			}
		}
		return cut;
	};
	let held = "";
	const flush = (text: string) => {
		if (text) emit(Buffer.from(replaceForms(text, list), "latin1"));
	};
	return {
		write: (data) => {
			const raw = held + data.toString("latin1");
			const cut = safeEnd(raw);
			held = raw.slice(cut);
			flush(raw.slice(0, cut));
		},
		end: () => {
			flush(held);
			held = "";
		},
	};
}

/** {@link maskingStream} as a stream transform, for output piped to a file. */
export function maskingTransform(secrets: Secrets): Transform {
	let stream: ReturnType<typeof maskingStream> | undefined;
	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			stream ??= maskingStream(secrets, (data) => this.push(data));
			stream.write(chunk);
			callback();
		},
		flush(callback) {
			stream?.end();
			callback();
		},
	});
}
