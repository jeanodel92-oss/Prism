/**
 * fork (R3.4 lot 2, F-H3 (b), D6): the credentials of new connections go to the Secret Service keyring through
 * libsecret's `secret-tool` (no npm dependency); auth.json keeps only a marker, `{ "type": …, "keyring":
 * "secret-service" }`. The rules:
 *
 * - a new connection uses the keyring when it works; a key already in clear in auth.json stays there until the
 *   migration, refreshed OAuth tokens included;
 * - without a keyring the credential goes to auth.json, never silently: the fallback is recorded for /doctor and
 *   a warning;
 * - a keyring that is there but locked, slow or refusing is not "without a keyring": nothing
 *   is written, the existing state stays, and the user is told to unlock it and try again;
 * - a missing or locked keyring gives an error the user can act on, not a missing key.
 *
 * - a locked keyring never freezes Prism: `secret-tool` runs asynchronously, killed past its time
 *   limit or when the operation is cancelled; credentials are read from it outside auth.json's lock, so a slow
 *   keyring does not hold the other writers either. Only `readStoredCredential`, a synchronous export Prism does not
 *   call, still waits for it.
 *
 * `PRISM_SECRET_SERVICE=off` turns the keyring off (the test suites set it, so no test writes to the
 * developer's keyring). Without `DBUS_SESSION_BUS_ADDRESS` the keyring is not tried either: libsecret would try
 * to launch a bus of its own.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AuthOperationOptions, Credential } from "@earendil-works/pi-ai";
import type { AuthStorageBackend } from "../../core/auth-storage.ts";
import { getConfigValueEnvVarNames, isCommandConfigValue } from "../../core/resolve-config-value.ts";
import { stripBom } from "../../utils/text.ts";
import { hostCommand, hostProgram, requireHostProgram } from "../host-program.ts";

export const KEYRING_MARKER = "secret-service";

/** A locked keyring asks to be unlocked; past `timeoutMs` the call fails with an error the user can act on. */
export const keyringTiming = { timeoutMs: 10_000 };

type StoredCredential = Credential | KeyringMarker;
type StoredData = Record<string, StoredCredential>;

export interface KeyringMarker {
	type: Credential["type"];
	keyring: typeof KEYRING_MARKER;
	/**
	 * fork: new at each store, so a process that cached the item before another one
	 * replaced it (an OAuth refresh, a new key) reads it again. Markers written before it have none.
	 */
	rev?: string;
}

/** What /doctor and the startup warning report, per auth.json path. */
export interface KeyringState {
	/** Providers whose credential is in the keyring. */
	stored: Set<string>;
	/** Providers whose marker could not be read back, with the reason. */
	unreadable: Map<string, string>;
	/** Providers written to auth.json because there is no keyring, with the reason. */
	fallback: Map<string, string>;
	/** Providers not saved at all because the keyring is there but failed, with the reason. */
	refused: Map<string, string>;
}

/** A keyring failure; `absent` when there is no Secret Service at all, rather than one that is locked or slow. */
type KeyringFailure = Error & { absent?: boolean };

function failure(message: string, absent: boolean): KeyringFailure {
	return Object.assign(new Error(message), { absent });
}

const states = new Map<string, KeyringState>();
/** Credentials read from or written to the keyring by this process, to mask them in tool results. */
const resolved = new Map<string, Map<string, Credential>>();
/** fork: per auth.json path, the marker revision each cached credential was read for. */
const revisions = new Map<string, Map<string, string | undefined>>();
const listeners = new Set<(message: string) => void>();
/** Warnings raised before anything listens (credentials load before the interface starts). */
const pending: string[] = [];

export function keyringState(authPath: string): KeyringState {
	let state = states.get(authPath);
	if (!state) {
		state = { stored: new Set(), unreadable: new Map(), fallback: new Map(), refused: new Map() };
		states.set(authPath, state);
	}
	return state;
}

/**
 * The credentials this process holds from the keyring, every auth.json path together, each with its provider.
 * fork: a list, not a map by provider, where the store read last hid another
 * store's key for the same provider from the secrets to mask.
 */
export function keyringCredentials(): Array<[string, Credential]> {
	return [...resolved.values()].flatMap((credentials) => [...credentials]);
}

/** Called with a message the user should see when the keyring fails (a write falls back, a read fails). */
export function onKeyringWarning(listener: (message: string) => void): () => void {
	listeners.add(listener);
	for (const message of pending.splice(0)) listener(message);
	return () => listeners.delete(listener);
}

function warn(message: string): void {
	if (!listeners.size) pending.push(message);
	for (const listener of listeners) listener(message);
}

export function keyringEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return process.platform === "linux" && env.PRISM_SECRET_SERVICE !== "off" && !!env.DBUS_SESSION_BUS_ADDRESS;
}

export function isKeyringMarker(value: unknown): value is KeyringMarker {
	return typeof value === "object" && value !== null && (value as { keyring?: unknown }).keyring === KEYRING_MARKER;
}

function attributes(authPath: string, provider: string): string[] {
	return ["application", "prism", "auth-file", authPath, "provider", provider];
}

/**
 * Whether the session bus has no Secret Service: none running and none it can start. dbus-daemon says so in
 * secret-tool's error; otherwise the bus is asked. When that cannot be told, the keyring counts as present, so a
 * failure never turns into a write in clear by default.
 */
const NO_SERVICE_FILE = "org.freedesktop.secrets was not provided by any .service files";
const busCall = (method: string, ...args: string[]) => [
	"call",
	"--session",
	"--dest",
	"org.freedesktop.DBus",
	"--object-path",
	"/org/freedesktop/DBus",
	"--method",
	`org.freedesktop.DBus.${method}`,
	...args,
];
const NOT_INSTALLED = "secret-tool is not installed (package libsecret or libsecret-tools)";
const NO_ANSWER = "the keyring did not answer in time; it may be locked";

function secretServiceAbsent(detail: string): boolean {
	if (detail.includes(NO_SERVICE_FILE)) return true;
	// fork: run at each session, never from where the sandbox writes.
	const bus = (method: string, ...args: string[]) =>
		execFileSync(requireHostProgram("gdbus"), busCall(method, ...args), {
			encoding: "utf8",
			timeout: 5_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
	try {
		if (bus("ListActivatableNames").includes("'org.freedesktop.secrets'")) return false;
		return bus("NameHasOwner", "org.freedesktop.secrets").includes("false");
	} catch {
		return false;
	}
}

/** `silent` is the error for a failure without a message. Blocks: only `readStoredCredential` comes here. */
function secretTool(args: string[], input?: string, silent = "secret-tool failed"): string {
	// fork: run at each session, never from where the sandbox writes.
	const program = hostProgram("secret-tool");
	if (!program) throw failure(NOT_INSTALLED, true);
	try {
		return execFileSync(program, args, {
			encoding: "utf8",
			input,
			timeout: keyringTiming.timeoutMs,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		const result = error as NodeJS.ErrnoException & { stderr?: string; signal?: string };
		if (result.code === "ENOENT") throw failure(NOT_INSTALLED, true);
		if (result.signal === "SIGTERM") throw failure(NO_ANSWER, false);
		const detail = result.stderr?.trim() ?? "";
		throw failure(detail ? `secret-tool failed: ${detail}` : silent, secretServiceAbsent(detail));
	}
}

interface ToolRun {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/**
 * Runs a program without blocking the event loop, killed past `timeout` or when `signal` aborts (then this rejects
 * with the signal's reason).
 */
function runTool(
	program: string,
	args: string[],
	{ input, timeout, signal }: { input?: string; timeout: number; signal?: AbortSignal },
): Promise<ToolRun> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.setEncoding("utf8").on("data", (data: string) => {
			stdout += data;
		});
		child.stderr.setEncoding("utf8").on("data", (data: string) => {
			stderr += data;
		});
		const kill = () => child.kill("SIGTERM");
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, timeout);
		signal?.addEventListener("abort", kill, { once: true });
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", kill);
		};
		child.on("error", (error) => {
			done();
			reject(error);
		});
		child.on("close", (code) => {
			done();
			if (signal?.aborted) reject(signal.reason);
			else resolve({ code, stdout, stderr, timedOut });
		});
		// A program that exits without reading its input.
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

async function secretServiceAbsentAsync(detail: string, signal?: AbortSignal): Promise<boolean> {
	if (detail.includes(NO_SERVICE_FILE)) return true;
	const bus = async (method: string, ...args: string[]) => {
		const run = await runTool(hostCommand("gdbus"), busCall(method, ...args), { timeout: 5_000, signal });
		if (run.code !== 0) throw new Error("gdbus failed");
		return run.stdout;
	};
	try {
		if ((await bus("ListActivatableNames")).includes("'org.freedesktop.secrets'")) return false;
		return (await bus("NameHasOwner", "org.freedesktop.secrets")).includes("false");
	} catch {
		signal?.throwIfAborted();
		return false;
	}
}

/** `secretTool` without blocking; `signal` kills it and rejects with its reason. */
async function secretToolAsync(
	args: string[],
	{ input, silent = "secret-tool failed", signal }: { input?: string; silent?: string; signal?: AbortSignal } = {},
): Promise<string> {
	let run: ToolRun;
	try {
		// fork: as the blocking variant, never from where the sandbox writes.
		run = await runTool(hostCommand("secret-tool"), args, { input, timeout: keyringTiming.timeoutMs, signal });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw failure(NOT_INSTALLED, true);
		throw error;
	}
	if (run.timedOut) throw failure(NO_ANSWER, false);
	if (run.code === 0) return run.stdout;
	const detail = run.stderr.trim();
	throw failure(detail ? `secret-tool failed: ${detail}` : silent, await secretServiceAbsentAsync(detail, signal));
}

// `lookup` fails without a word when the item is missing, or when the user declined to unlock the keyring.
const MISSING = "the keyring has no such item, or it is locked";

function lookup(authPath: string, provider: string): Credential {
	return parseItem(secretTool(["lookup", ...attributes(authPath, provider)], undefined, MISSING));
}

async function lookupAsync(authPath: string, provider: string, signal?: AbortSignal): Promise<Credential> {
	return parseItem(await secretToolAsync(["lookup", ...attributes(authPath, provider)], { silent: MISSING, signal }));
}

function parseItem(output: string): Credential {
	if (!output) throw new Error(MISSING);
	const credential = JSON.parse(output) as Credential;
	if (typeof credential !== "object" || credential === null || typeof credential.type !== "string") {
		throw new Error("the keyring item is not a credential");
	}
	return credential;
}

async function store(authPath: string, provider: string, credential: Credential, signal?: AbortSignal): Promise<void> {
	await secretToolAsync(["store", `--label=Prism: ${provider} (${authPath})`, ...attributes(authPath, provider)], {
		input: JSON.stringify(credential),
		signal,
	});
}

async function clear(authPath: string, provider: string): Promise<void> {
	try {
		await secretToolAsync(["clear", ...attributes(authPath, provider)]);
	} catch {
		// The marker is gone from auth.json either way; a stale item only costs space in the keyring.
	}
}

function cache(authPath: string): Map<string, Credential> {
	let credentials = resolved.get(authPath);
	if (!credentials) {
		credentials = new Map();
		resolved.set(authPath, credentials);
	}
	return credentials;
}

function revisionsOf(authPath: string): Map<string, string | undefined> {
	let byProvider = revisions.get(authPath);
	if (!byProvider) {
		byProvider = new Map();
		revisions.set(authPath, byProvider);
	}
	return byProvider;
}

/** fork: the cached credential, only if it is the one `marker` names. */
function cachedFor(authPath: string, provider: string, marker: KeyringMarker): Credential | undefined {
	if (revisionsOf(authPath).get(provider) !== marker.rev) return undefined;
	return cache(authPath).get(provider);
}

function newMarker(type: Credential["type"]): KeyringMarker {
	return { type, keyring: KEYRING_MARKER, rev: randomUUID() };
}

function parse(content: string | undefined): StoredData {
	if (!content) return {};
	return JSON.parse(stripBom(content)) as StoredData;
}

/** The markers of `content` not read from the keyring yet (or read for another revision), nor found unreadable. */
function pendingMarkers(authPath: string, content: string | undefined): Array<[string, KeyringMarker]> {
	const state = keyringState(authPath);
	const pending: Array<[string, KeyringMarker]> = [];
	for (const [provider, credential] of Object.entries(parse(content))) {
		if (!isKeyringMarker(credential) || state.unreadable.has(provider)) continue;
		if (!cachedFor(authPath, provider, credential)) pending.push([provider, credential]);
	}
	return pending;
}

export function hasPendingKeyringMarkers(authPath: string, content: string | undefined): boolean {
	try {
		return pendingMarkers(authPath, content).length > 0;
	} catch {
		return false;
	}
}

function noteRead(authPath: string, provider: string, credential: Credential, rev: string | undefined): void {
	const state = keyringState(authPath);
	cache(authPath).set(provider, credential);
	revisionsOf(authPath).set(provider, rev);
	state.stored.add(provider);
	state.unreadable.delete(provider);
}

/**
 * A marker that cannot be read stays a marker (no key), recorded with its reason and reported once; it is not
 * asked again in this process (a locked keyring would prompt at each reload): the user restarts or logs in again.
 */
function noteUnreadable(authPath: string, provider: string, error: unknown): void {
	const reason = (error as Error).message;
	warn(
		`The credential of ${provider} is in the keyring, which could not be read: ${reason}. Unlock the keyring, then restart Prism, or log in again with /login.`,
	);
	keyringState(authPath).unreadable.set(provider, reason);
}

/**
 * Reads from the keyring, without blocking, the credentials `content`'s markers name and this process has not read
 * yet; `resolveKeyringContent` then puts them in place. Rejects only when `signal` aborts.
 */
export async function loadKeyringCredentials(
	authPath: string,
	content: string | undefined,
	signal?: AbortSignal,
): Promise<void> {
	let pending: Array<[string, KeyringMarker]>;
	try {
		pending = pendingMarkers(authPath, content);
	} catch {
		// Not JSON: the store reports it.
		return;
	}
	for (const [provider, marker] of pending) {
		try {
			if (!keyringEnabled()) throw new Error("the keyring is not available in this session");
			noteRead(authPath, provider, await lookupAsync(authPath, provider, signal), marker.rev);
		} catch (error) {
			signal?.throwIfAborted();
			noteUnreadable(authPath, provider, error);
		}
	}
}

/**
 * auth.json as Prism's credential store sees it: each marker replaced by the credential read from the keyring.
 * `cachedOnly` puts in place only what `loadKeyringCredentials` (or a write) already read; otherwise a marker not
 * read yet is read here, blocking, for `readStoredCredential`.
 */
export function resolveKeyringContent(
	authPath: string,
	content: string | undefined,
	{ cachedOnly = false }: { cachedOnly?: boolean } = {},
): string | undefined {
	const data = parse(content);
	const markers = Object.entries(data).filter((entry): entry is [string, KeyringMarker] => isKeyringMarker(entry[1]));
	if (!markers.length) return content;
	const state = keyringState(authPath);
	for (const [provider, marker] of markers) {
		const known = cachedFor(authPath, provider, marker);
		if (known) {
			data[provider] = known;
			continue;
		}
		if (state.unreadable.has(provider) || cachedOnly) continue;
		try {
			if (!keyringEnabled()) throw new Error("the keyring is not available in this session");
			const credential = lookup(authPath, provider);
			noteRead(authPath, provider, credential, marker.rev);
			data[provider] = credential;
		} catch (error) {
			noteUnreadable(authPath, provider, error);
		}
	}
	return JSON.stringify(data, null, 2);
}

/** A value that names where the key comes from (`!command`, `$VAR`) rather than holding it stays in auth.json. */
export function holdsSecret(credential: Credential): boolean {
	if (credential.type !== "api_key") return true;
	const key = credential.key;
	return !!key && !isCommandConfigValue(key) && getConfigValueEnvVarNames(key).length === 0;
}

function same(a: Credential | undefined, b: Credential): boolean {
	return !!a && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The auth.json to write for `next` (the store's view, markers resolved), given the file's `current` content:
 * a new connection, or a change to a credential already in the keyring, goes to the keyring and leaves a marker.
 * Throws, so nothing is written, when the keyring is there but fails, or when a credential already in it cannot
 * be updated: neither may end up in clear.
 */
/**
 * What a write did to the keyring, applied by `commitKeyringWrite` once auth.json is written: an item is
 * removed only then, so a failed write never leaves a marker without its item.
 */
export interface KeyringWrite {
	next: string;
	/** Provider, credential stored, and the revision of its new marker. */
	saved: Array<[string, Credential, string | undefined]>;
	removed: string[];
}

/** What a write asks of the keyring, before any call: the credentials to store, with what auth.json held. */
interface KeyringPlan {
	after: StoredData;
	store: Array<[string, Credential, StoredCredential | undefined]>;
	removed: string[];
}

function planKeyringWrite(authPath: string, current: string | undefined, next: string): KeyringPlan {
	const before = parse(current);
	const after = parse(next);
	const removed = Object.keys(before).filter((provider) => isKeyringMarker(before[provider]) && !(provider in after));
	const store: KeyringPlan["store"] = [];
	for (const [provider, credential] of Object.entries(after)) {
		if (isKeyringMarker(credential)) continue;
		const previous = before[provider];
		// A key already in clear stays there until the migration; so does a reference.
		if ((previous && !isKeyringMarker(previous)) || !holdsSecret(credential)) {
			if (isKeyringMarker(previous)) removed.push(provider);
			continue;
		}
		if (isKeyringMarker(previous) && same(cachedFor(authPath, provider, previous), credential)) {
			after[provider] = previous;
			continue;
		}
		store.push([provider, credential, previous]);
	}
	return { after, store, removed };
}

/** A write through the synchronous lock: the keyring is not called there, so one that needs it is refused. */
export function externalizeCachedKeyringContent(authPath: string, current: string | undefined, next: string): string {
	const plan = planKeyringWrite(authPath, current, next);
	if (plan.store.length || plan.removed.length)
		throw new Error("Saving or removing a credential in the keyring goes through withLockAsync.");
	return JSON.stringify(plan.after, null, 2);
}

export async function externalizeKeyringContent(
	authPath: string,
	current: string | undefined,
	next: string,
	signal?: AbortSignal,
): Promise<KeyringWrite> {
	const { after, store: toStore, removed } = planKeyringWrite(authPath, current, next);
	const state = keyringState(authPath);
	const credentials = cache(authPath);
	const saved: KeyringWrite["saved"] = [];
	for (const [provider, credential, previous] of toStore) {
		try {
			if (!keyringEnabled()) throw failure("the keyring is not available in this session", true);
			await store(authPath, provider, credential, signal);
			const marker = newMarker(credential.type);
			saved.push([provider, credential, marker.rev]);
			after[provider] = marker;
		} catch (error) {
			// Cancelled: nothing is written (an item stored for an earlier provider stays unused).
			signal?.throwIfAborted();
			const reason = (error as KeyringFailure).message;
			if (!(error as KeyringFailure).absent || previous) {
				state.refused.set(provider, reason);
				throw new Error(
					`Nothing was saved for ${provider}: the keyring did not take the credential (${reason}). Unlock the keyring, then try again.`,
				);
			}
			state.fallback.set(provider, reason);
			state.stored.delete(provider);
			credentials.delete(provider);
			warn(`The credential of ${provider} was saved in clear in auth.json: there is no keyring (${reason}).`);
		}
	}
	return { next: JSON.stringify(after, null, 2), saved, removed };
}

function noteStored(authPath: string, provider: string, credential: Credential, rev: string | undefined): void {
	const state = keyringState(authPath);
	cache(authPath).set(provider, credential);
	revisionsOf(authPath).set(provider, rev);
	state.stored.add(provider);
	state.unreadable.delete(provider);
	state.fallback.delete(provider);
	state.refused.delete(provider);
}

/**
 * After auth.json was written: records what was stored, then removes the items it no longer names, under its lock
 * again and only if it still does not name them (another process may have saved the provider meanwhile). A crash
 * before this leaves an item no marker names: unused, never a lost credential; the next save of the provider
 * overwrites it.
 */
async function commitKeyringWrite(authPath: string, inner: AuthStorageBackend, write: KeyringWrite): Promise<void> {
	for (const [provider, credential, rev] of write.saved) noteStored(authPath, provider, credential, rev);
	if (!write.removed.length) return;
	await inner.withLockAsync(async (current) => {
		const data = parse(current);
		for (const provider of write.removed) {
			if (isKeyringMarker(data[provider])) continue;
			await clear(authPath, provider);
			cache(authPath).delete(provider);
			const state = keyringState(authPath);
			state.stored.delete(provider);
			state.unreadable.delete(provider);
		}
		return { result: undefined };
	});
}

/** A write that failed after items were stored: the keyring may hold newer values than the cache. */
function forgetCached(authPath: string, write: KeyringWrite | undefined): void {
	for (const [provider] of write?.saved ?? []) cache(authPath).delete(provider);
}

/**
 * Lot 3 (migration): stores a credential that is in clear in auth.json, then reads it back and compares, and
 * returns the marker to put in its place. Throws when the keyring fails or gives back something else, in which
 * case the credential must stay in clear (an item that did not read back is removed).
 */
export async function moveToKeyring(
	authPath: string,
	provider: string,
	credential: Credential,
	signal?: AbortSignal,
): Promise<KeyringMarker> {
	if (!keyringEnabled()) throw failure("the keyring is not available in this session", true);
	await store(authPath, provider, credential, signal);
	if (!same(await lookupAsync(authPath, provider, signal), credential)) {
		await clear(authPath, provider);
		throw failure("the keyring gave back another value", false);
	}
	return newMarker(credential.type);
}

/** Lot 3, once auth.json holds the markers: the moved credentials are read from the keyring from now on. */
export function noteMoved(authPath: string, moved: Array<[string, Credential, string | undefined]>): void {
	for (const [provider, credential, rev] of moved) noteStored(authPath, provider, credential, rev);
}

/** auth.json through the keyring: reads see the credentials, writes leave markers (see the top of this file). */
export class KeyringAuthStorageBackend implements AuthStorageBackend {
	private readonly inner: AuthStorageBackend;
	private readonly authPath: string;

	constructor(inner: AuthStorageBackend, authPath: string) {
		this.inner = inner;
		this.authPath = authPath;
	}

	/** Never waits for the keyring: markers not read yet stay markers, and a write that needs it fails. */
	withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
		return this.inner.withLock((current) => {
			const out = fn(resolveKeyringContent(this.authPath, current, { cachedOnly: true }));
			if (out.next === undefined) return { result: out.result };
			return { result: out.result, next: externalizeCachedKeyringContent(this.authPath, current, out.next) };
		});
	}

	async withLockAsync<T>(
		fn: (current: string | undefined) => Promise<{ result: T; next?: string }>,
		options?: AuthOperationOptions,
	): Promise<T> {
		const signal = options?.signal;
		// Read outside the lock, so that a slow keyring holds no other writer; auth.json is replaced whole, never seen
		// half written. What changed meanwhile is read under the lock.
		let unlocked: string | undefined;
		try {
			unlocked = readFileSync(this.authPath, "utf-8");
		} catch {
			unlocked = undefined;
		}
		await loadKeyringCredentials(this.authPath, unlocked, signal);
		let write: KeyringWrite | undefined;
		let result: T;
		try {
			result = await this.inner.withLockAsync(async (current) => {
				await loadKeyringCredentials(this.authPath, current, signal);
				const out = await fn(resolveKeyringContent(this.authPath, current, { cachedOnly: true }));
				if (out.next === undefined) return { result: out.result };
				write = await externalizeKeyringContent(this.authPath, current, out.next, signal);
				return { result: out.result, next: write.next };
			}, options);
		} catch (error) {
			forgetCached(this.authPath, write);
			throw error;
		}
		if (write) await commitKeyringWrite(this.authPath, this.inner, write);
		return result;
	}
}

/** Forgets the credentials read from the keyring, so the next read asks it again (tests start from here). */
export function forgetKeyringCredentials(): void {
	resolved.clear();
	revisions.clear();
	states.clear();
}
