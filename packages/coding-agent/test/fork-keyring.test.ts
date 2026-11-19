/**
 * fork: new connections go to the Secret Service keyring, auth.json keeps a marker. A fake
 * `secret-tool` (a shell script keeping items in a temporary folder) stands for libsecret, and a fake `gdbus`
 * for the session bus: no test reaches a real keyring.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, FileAuthStorageBackend, ReadOnlyAuthStorage } from "../src/core/auth-storage.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { buildStartupDoctorReport } from "../src/fork/doctor.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { atomicWriteHooks } from "../src/fork/secrets/atomic-write.ts";
import { storedSecrets } from "../src/fork/secrets/env.ts";
import {
	externalizeKeyringContent,
	forgetKeyringCredentials,
	keyringState,
	keyringTiming,
	onKeyringWarning,
} from "../src/fork/secrets/keyring.ts";
import { credentialsInClear, migrateToKeyring } from "../src/fork/secrets/migration.ts";
import { MigrationPage } from "../src/fork/secrets/migration-page.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const FAKE_SECRET_TOOL = `#!/bin/sh
cmd=$1; shift
[ "$cmd" = store ] && shift
item="$FAKE_KEYRING/$(printf '%s ' "$@" | sha1sum | cut -c1-40)"
# A slow or locked keyring: FAKE_KEYRING_SLOW names the command that waits FAKE_KEYRING_DELAY seconds.
if [ "$cmd" = "$FAKE_KEYRING_SLOW" ]; then
	trap 'kill $! 2>/dev/null; [ -n "$FAKE_KEYRING_LOG" ] && echo "killed $cmd" >> "$FAKE_KEYRING_LOG"; exit 143' TERM
	[ -n "$FAKE_KEYRING_LOG" ] && echo "waits $cmd" >> "$FAKE_KEYRING_LOG"
	sleep "$FAKE_KEYRING_DELAY" </dev/null >/dev/null 2>&1 & wait $!
fi
case $cmd in
	store) [ -n "$FAKE_KEYRING_FAIL" ] && { echo "$FAKE_KEYRING_FAIL" >&2; exit 1; }
		case " $* " in *" provider $FAKE_KEYRING_FAIL_PROVIDER "*) echo "Cannot create an item in a locked collection" >&2; exit 1 ;; esac
		cat > "$item" ;;
	lookup) [ -f "$item" ] || exit 1; [ -n "$FAKE_KEYRING_CORRUPT" ] && { echo '{"type":"api_key","key":"other"}'; exit 0; }; cat "$item" ;;
	clear) rm -f "$item" ;;
esac
`;

// The session bus: a Secret Service is there (running or startable) unless FAKE_SECRET_SERVICE=absent.
const FAKE_GDBUS = `#!/bin/sh
[ -n "$FAKE_GDBUS_FAIL" ] && exit 1
case "$*" in
	*ListActivatableNames*) [ "$FAKE_SECRET_SERVICE" = absent ] && echo "(['org.freedesktop.DBus'],)" || echo "(['org.freedesktop.DBus', 'org.freedesktop.secrets'],)" ;;
	*NameHasOwner*) [ "$FAKE_SECRET_SERVICE" = absent ] && echo "(false,)" || echo "(true,)" ;;
esac
`;

const KEY = "sk-keyring-canary-0123456789";
const LOCKED = "Cannot create an item in a locked collection";
/** What secret-tool says under dbus-daemon when no Secret Service exists. */
const NO_SERVICE = "The name org.freedesktop.secrets was not provided by any .service files";

let root: string;
let keyring: string;
let agentDir: string;
let authPath: string;
let warnings: string[];
let stopWarnings: () => void;

function file(): Record<string, Record<string, unknown>> {
	return JSON.parse(readFileSync(authPath, "utf8"));
}

/** A keyring marker as auth.json holds it; its revision is new at each store. */
function marker(type: string) {
	return { type, keyring: "secret-service", rev: expect.any(String) };
}

function items(): string[] {
	return readdirSync(keyring);
}

describe("Secret Service keyring for new connections", () => {
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-keyring-"));
		keyring = join(root, "keyring");
		agentDir = join(root, "agent");
		mkdirSync(keyring);
		mkdirSync(agentDir);
		mkdirSync(join(root, "bin"));
		for (const [name, script] of [
			["secret-tool", FAKE_SECRET_TOOL],
			["gdbus", FAKE_GDBUS],
		]) {
			writeFileSync(join(root, "bin", name!), script!);
			chmodSync(join(root, "bin", name!), 0o755);
		}
		authPath = join(agentDir, "auth.json");
		vi.stubEnv("PATH", `${join(root, "bin")}:${process.env.PATH}`);
		vi.stubEnv("FAKE_KEYRING", keyring);
		vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/nonexistent/fake-bus");
		vi.stubEnv("PRISM_SECRET_SERVICE", "");
		warnings = [];
		stopWarnings = onKeyringWarning((message) => warnings.push(message));
	});

	afterEach(() => {
		stopWarnings();
		forgetKeyringCredentials();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps a new key in the keyring, with only a marker in auth.json, and reads it back", async () => {
		await AuthStorage.create(authPath).modify("openai", async () => ({ type: "api_key", key: KEY }));
		expect(file()).toEqual({ openai: marker("api_key") });
		expect(readFileSync(authPath, "utf8")).not.toContain(KEY);
		expect(items()).toHaveLength(1);

		forgetKeyringCredentials();
		expect(await AuthStorage.create(authPath).read("openai")).toEqual({ type: "api_key", key: KEY });
		forgetKeyringCredentials();
		expect(await new ReadOnlyAuthStorage(authPath).read("openai")).toEqual({ type: "api_key", key: KEY });
		expect(keyringState(authPath).stored.has("openai")).toBe(true);
		expect(warnings).toEqual([]);
	});

	// fork: the cache follows the marker, which another process renews when it stores.
	it("reads again a credential another process replaced in the keyring", async () => {
		const storage = AuthStorage.create(authPath);
		await storage.modify("openai", async () => ({ type: "api_key", key: KEY }));
		expect(await storage.read("openai")).toEqual({ type: "api_key", key: KEY });
		// What another Prism does when it replaces the key (an OAuth refresh likewise): a new item, a new marker.
		const replaced = "sk-replaced-elsewhere-0123456789";
		const write = await externalizeKeyringContent(
			authPath,
			readFileSync(authPath, "utf8"),
			JSON.stringify({ openai: { type: "api_key", key: replaced } }),
		);
		writeFileSync(authPath, write.next);

		expect(await storage.read("openai")).toEqual({ type: "api_key", key: replaced });
		let seen: unknown;
		await AuthStorage.create(authPath).modify("openai", async (current) => {
			seen = current;
			return current;
		});
		expect(seen).toEqual({ type: "api_key", key: replaced });
		expect(file()).toEqual({ openai: marker("api_key") });
	});

	it("leaves a key already in clear where it is, OAuth refreshes included (migration is a later step)", async () => {
		writeFileSync(
			authPath,
			JSON.stringify({
				anthropic: { type: "oauth", access: "a-old-0123456789", refresh: "r-old-0123456789", expires: 1 },
			}),
		);
		await AuthStorage.create(authPath).modify("anthropic", async () => ({
			type: "oauth",
			access: "a-new-0123456789",
			refresh: "r-new-0123456789",
			expires: 2,
		}));
		expect(file().anthropic).toMatchObject({ access: "a-new-0123456789" });
		expect(items()).toEqual([]);
	});

	it("keeps a reference to a key (a command, a variable) in auth.json", async () => {
		const storage = AuthStorage.create(authPath);
		await storage.modify("a", async () => ({ type: "api_key", key: "!pass show api" }));
		await storage.modify("b", async () => ({ type: "api_key", key: "$MY_API_KEY" }));
		expect(file()).toEqual({
			a: { type: "api_key", key: "!pass show api" },
			b: { type: "api_key", key: "$MY_API_KEY" },
		});
		expect(items()).toEqual([]);
	});

	it("saves in clear only when there is no Secret Service at all, never silently", async () => {
		vi.stubEnv("FAKE_KEYRING_FAIL", NO_SERVICE);
		await AuthStorage.create(authPath).modify("openai", async () => ({ type: "api_key", key: KEY }));
		expect(file().openai).toEqual({ type: "api_key", key: KEY });
		expect(warnings).toEqual([
			`The credential of openai was saved in clear in auth.json: there is no keyring (secret-tool failed: ${NO_SERVICE}).`,
		]);
		// Another bus (dbus-broker) words it otherwise: the bus itself says no service runs or can start.
		vi.stubEnv("FAKE_KEYRING_FAIL", "Remote peer disconnected");
		vi.stubEnv("FAKE_SECRET_SERVICE", "absent");
		await AuthStorage.create(authPath).modify("other", async () => ({ type: "api_key", key: `${KEY}-2` }));
		expect(file().other).toEqual({ type: "api_key", key: `${KEY}-2` });
		expect(keyringState(authPath).fallback.get("other")).toBe("secret-tool failed: Remote peer disconnected");
		expect(warnings).toHaveLength(2);
	});

	it("saves nothing when the keyring is there but locked, keeps the file and says to retry", async () => {
		const before = JSON.stringify({ old: { type: "api_key", key: "plain-0123456789" } });
		writeFileSync(authPath, before);
		vi.stubEnv("FAKE_KEYRING_FAIL", LOCKED);
		const storage = AuthStorage.create(authPath);
		await expect(storage.modify("openai", async () => ({ type: "api_key", key: KEY }))).rejects.toThrow(
			`Nothing was saved for openai: the keyring did not take the credential (secret-tool failed: ${LOCKED}). Unlock the keyring, then try again.`,
		);
		expect(readFileSync(authPath, "utf8")).toBe(before);
		expect(items()).toEqual([]);
		expect(warnings).toEqual([]);
		const report = await buildStartupDoctorReport({ cwd: root, agentDir, sessionDir: root });
		expect(report.checks.find((check) => check.component === "Keyring")).toMatchObject({
			status: "problem",
			detail: `openai: secret-tool failed: ${LOCKED}`,
		});

		// Unlocked, the same login goes through.
		vi.stubEnv("FAKE_KEYRING_FAIL", "");
		await storage.modify("openai", async () => ({ type: "api_key", key: KEY }));
		expect(file().openai).toEqual(marker("api_key"));
		expect(keyringState(authPath).refused.size).toBe(0);
	});

	it("counts the keyring as there when the bus cannot be asked", async () => {
		vi.stubEnv("FAKE_KEYRING_FAIL", "Remote peer disconnected");
		vi.stubEnv("FAKE_GDBUS_FAIL", "1");
		await expect(
			AuthStorage.create(authPath).modify("openai", async () => ({ type: "api_key", key: KEY })),
		).rejects.toThrow(/^Nothing was saved for openai/);
		expect(existsSync(authPath) ? readFileSync(authPath, "utf8") : "").not.toContain(KEY);
	});

	it("never moves a credential already in the keyring to clear, even with no keyring left", async () => {
		const storage = AuthStorage.create(authPath);
		await storage.modify("openai", async () => ({ type: "api_key", key: KEY }));
		vi.stubEnv("FAKE_KEYRING_FAIL", NO_SERVICE);
		await expect(storage.modify("openai", async () => ({ type: "api_key", key: `${KEY}-new` }))).rejects.toThrow(
			/^Nothing was saved for openai/,
		);
		expect(file()).toEqual({ openai: marker("api_key") });
		expect(await storage.read("openai")).toEqual({ type: "api_key", key: KEY });
	});

	it("does not try the keyring without a D-Bus session or when turned off, and says so", async () => {
		vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "");
		await AuthStorage.create(authPath).modify("openai", async () => ({ type: "api_key", key: KEY }));
		expect(file().openai).toEqual({ type: "api_key", key: KEY });
		expect(keyringState(authPath).fallback.get("openai")).toBe("the keyring is not available in this session");
		expect(warnings).toHaveLength(1);
		const report = await buildStartupDoctorReport({ cwd: root, agentDir, sessionDir: root });
		expect(report.checks.find((check) => check.component === "Keyring")).toMatchObject({ status: "problem" });
	});

	it("reports a marker it cannot read, and keeps it when another credential changes", async () => {
		await AuthStorage.create(authPath).modify("openai", async () => ({ type: "api_key", key: KEY }));
		const [item] = items();
		const saved = readFileSync(join(keyring, item!), "utf8");
		rmSync(join(keyring, item!));
		forgetKeyringCredentials();

		const storage = AuthStorage.create(authPath);
		expect((await storage.read("openai"))?.type).toBe("api_key");
		expect((await storage.read("openai")) as { key?: string }).not.toHaveProperty("key");
		expect(keyringState(authPath).unreadable.get("openai")).toBe("the keyring has no such item, or it is locked");
		expect(warnings[0]).toMatch(/^The credential of openai is in the keyring, which could not be read/);

		// Not asked again in this process (a locked keyring would prompt at each reload), even once it answers.
		writeFileSync(join(keyring, item!), saved);
		await storage.modify("other", async () => ({ type: "api_key", key: "!other" }));
		expect(file().openai).toEqual(marker("api_key"));
		expect((await storage.read("openai")) as { key?: string }).not.toHaveProperty("key");
		expect(warnings).toHaveLength(1);
		const report = await buildStartupDoctorReport({ cwd: root, agentDir, sessionDir: root });
		expect(report.checks.find((check) => check.component === "Keyring")).toMatchObject({
			status: "problem",
			detail: "openai: the keyring has no such item, or it is locked",
		});
	});

	it("removes the keyring item on logout", async () => {
		const storage = AuthStorage.create(authPath);
		await storage.modify("openai", async () => ({ type: "api_key", key: KEY }));
		expect(items()).toHaveLength(1);
		await storage.delete("openai");
		expect(items()).toEqual([]);
		expect(file()).toEqual({});
	});

	it("masks a key held in the keyring in tool results", async () => {
		await AuthStorage.create(authPath).modify("openai", async () => ({ type: "api_key", key: KEY }));
		expect(storedSecrets(agentDir).get(KEY)).toBe("keyring openai");
	});

	it("tells /doctor where the credentials are", async () => {
		await AuthStorage.create(authPath).modify("openai", async () => ({ type: "api_key", key: KEY }));
		writeFileSync(authPath, JSON.stringify({ ...file(), old: { type: "api_key", key: "plain-0123456789" } }));
		const report = await buildStartupDoctorReport({ cwd: root, agentDir, sessionDir: root });
		expect(report.checks.find((check) => check.component === "Keyring")).toMatchObject({
			status: "ok",
			detail: "keyring: openai; auth.json: old",
		});
		expect(existsSync(authPath)).toBe(true);
	});

	// fork: a locked keyring must not freeze Prism for its 10 to 30 seconds, nor
	// hold the other writers of auth.json, nor turn into a key in clear.
	describe("a slow or locked keyring", () => {
		const NO_ANSWER = "the keyring did not answer in time; it may be locked";
		const slow = (command: string, seconds: number) => {
			vi.stubEnv("FAKE_KEYRING_SLOW", command);
			vi.stubEnv("FAKE_KEYRING_DELAY", String(seconds));
		};
		/** Counts the event loop's turns from now on (one each 20 ms); a blocked loop counts none. */
		const loopTurns = () => {
			let turns = 0;
			const timer = setInterval(() => turns++, 20);
			return () => {
				clearInterval(timer);
				return turns;
			};
		};
		const log = () => join(root, "keyring.log");
		const logged = () => (existsSync(log()) ? readFileSync(log(), "utf8") : "");
		const until = async (condition: () => boolean) => {
			const deadline = Date.now() + 10_000;
			while (!condition() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
			expect(condition()).toBe(true);
		};
		const saveKey = async () => {
			await AuthStorage.create(authPath).modify("openai", async () => ({ type: "api_key", key: KEY }));
			forgetKeyringCredentials();
		};
		afterEach(() => {
			keyringTiming.timeoutMs = 10_000;
		});

		it("reads nothing from the keyring at startup, and the key without blocking once asked", async () => {
			await saveKey();
			slow("lookup", 1);
			const started = Date.now();
			const storage = AuthStorage.create(authPath);
			expect(Date.now() - started).toBeLessThan(500);
			const turns = loopTurns();
			expect(await storage.read("openai")).toEqual({ type: "api_key", key: KEY });
			expect(turns()).toBeGreaterThan(20);
			forgetKeyringCredentials();
			const readOnly = loopTurns();
			expect(await new ReadOnlyAuthStorage(authPath).read("openai")).toEqual({ type: "api_key", key: KEY });
			expect(readOnly()).toBeGreaterThan(20);
		});

		it("gives up on a keyring that does not answer, saves nothing, and never in clear", async () => {
			keyringTiming.timeoutMs = 500;
			slow("store", 30);
			const before = JSON.stringify({ old: { type: "api_key", key: "plain-0123456789" } });
			writeFileSync(authPath, before);
			const turns = loopTurns();
			const started = Date.now();
			await expect(
				AuthStorage.create(authPath).modify("openai", async () => ({ type: "api_key", key: KEY })),
			).rejects.toThrow(
				`Nothing was saved for openai: the keyring did not take the credential (${NO_ANSWER}). Unlock the keyring, then try again.`,
			);
			expect(Date.now() - started).toBeLessThan(5_000);
			expect(turns()).toBeGreaterThan(15);
			expect(readFileSync(authPath, "utf8")).toBe(before);
			expect(keyringState(authPath).refused.get("openai")).toBe(NO_ANSWER);
			expect(keyringState(authPath).fallback.size).toBe(0);
			expect(items()).toEqual([]);
		});

		it("leaves a marker the keyring does not give back in time a marker, and says so once", async () => {
			await saveKey();
			keyringTiming.timeoutMs = 500;
			slow("lookup", 30);
			const storage = AuthStorage.create(authPath);
			expect((await storage.read("openai")) as { key?: string }).not.toHaveProperty("key");
			expect(keyringState(authPath).unreadable.get("openai")).toBe(NO_ANSWER);
			expect(warnings).toHaveLength(1);
			expect(file()).toEqual({ openai: marker("api_key") });
		});

		it("stops the keyring call when the operation is cancelled, and asks again the next time", async () => {
			await saveKey();
			vi.stubEnv("FAKE_KEYRING_LOG", log());
			slow("lookup", 30);
			const controller = new AbortController();
			const reading = AuthStorage.create(authPath).read("openai", { signal: controller.signal });
			await until(() => logged().includes("waits lookup"));
			controller.abort(new Error("cancelled by the user"));
			await expect(reading).rejects.toThrow("cancelled by the user");
			await until(() => logged().includes("killed lookup"));
			expect(keyringState(authPath).unreadable.size).toBe(0);
			expect(warnings).toEqual([]);

			// A save cancelled while the keyring waits: nothing written, nothing refused, nothing in clear.
			slow("store", 30);
			const saving = new AbortController();
			const save = AuthStorage.create(authPath).modify("other", async () => ({ type: "api_key", key: `${KEY}-2` }), {
				signal: saving.signal,
			});
			await until(() => logged().includes("waits store"));
			saving.abort(new Error("cancelled by the user"));
			await expect(save).rejects.toThrow("cancelled by the user");
			await until(() => logged().includes("killed store"));
			expect(file()).toEqual({ openai: marker("api_key") });
			expect(keyringState(authPath).refused.size).toBe(0);
			expect(keyringState(authPath).fallback.size).toBe(0);

			slow("", 0);
			expect(await AuthStorage.create(authPath).read("openai")).toEqual({ type: "api_key", key: KEY });
		});

		it("holds no other writer while it reads the keyring, and loses no write of either", async () => {
			await saveKey();
			slow("lookup", 1.5);
			const turns = loopTurns();
			const first = AuthStorage.create(authPath).modify("ref", async () => ({ type: "api_key", key: "!pass ref" }));
			await new Promise((done) => setTimeout(done, 100));
			const started = Date.now();
			await new FileAuthStorageBackend(authPath).withLockAsync(async (current) => ({
				result: undefined,
				next: JSON.stringify({ ...JSON.parse(current ?? "{}"), other: { type: "api_key", key: "!pass other" } }),
			}));
			// The other writer did not wait for the keyring.
			expect(Date.now() - started).toBeLessThan(1_000);
			await first;
			expect(turns()).toBeGreaterThan(30);
			expect(file()).toEqual({
				openai: marker("api_key"),
				ref: { type: "api_key", key: "!pass ref" },
				other: { type: "api_key", key: "!pass other" },
			});
		});

		it("makes another writer wait while it stores in the keyring, then keeps both writes", async () => {
			slow("store", 1);
			const first = AuthStorage.create(authPath).modify("openai", async () => ({ type: "api_key", key: KEY }));
			await new Promise((done) => setTimeout(done, 100));
			await new FileAuthStorageBackend(authPath).withLockAsync(async (current) => ({
				result: undefined,
				next: JSON.stringify({ ...JSON.parse(current ?? "{}"), other: { type: "api_key", key: "!pass other" } }),
			}));
			await first;
			expect(file()).toEqual({
				openai: marker("api_key"),
				other: { type: "api_key", key: "!pass other" },
			});
			forgetKeyringCredentials();
			slow("", 0);
			expect(await AuthStorage.create(authPath).read("openai")).toEqual({ type: "api_key", key: KEY });
		});

		it("moves credentials to the keyring without blocking, and keeps one in clear when it does not answer", async () => {
			writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: KEY } }));
			keyringTiming.timeoutMs = 500;
			slow("store", 30);
			const turns = loopTurns();
			const result = await migrateToKeyring(authPath);
			expect(result.kept.get("openai")).toBe(NO_ANSWER);
			expect(turns()).toBeGreaterThan(15);
			expect(file()).toEqual({ openai: { type: "api_key", key: KEY } });
		});
	});

	describe("moving the credentials in clear", () => {
		const plain = () => ({
			anthropic: { type: "oauth", access: "a-0123456789", refresh: "r-0123456789", expires: 1 },
			openai: { type: "api_key", key: KEY },
			ref: { type: "api_key", key: "!pass show api" },
		});

		it("moves only the credentials in clear, reads them back, and leaves references", async () => {
			writeFileSync(authPath, JSON.stringify(plain()));
			expect(credentialsInClear(authPath)).toEqual([
				{ provider: "anthropic", type: "oauth" },
				{ provider: "openai", type: "api_key" },
			]);
			const result = await migrateToKeyring(authPath);
			expect(result).toEqual({ moved: ["anthropic", "openai"], kept: new Map() });
			expect(file()).toEqual({
				anthropic: marker("oauth"),
				openai: marker("api_key"),
				ref: { type: "api_key", key: "!pass show api" },
			});
			expect(readFileSync(authPath, "utf8")).not.toMatch(/0123456789/);
			forgetKeyringCredentials();
			const storage = AuthStorage.create(authPath);
			expect(await storage.read("openai")).toEqual({ type: "api_key", key: KEY });
			expect(await storage.read("anthropic")).toMatchObject({ refresh: "r-0123456789" });
			expect(credentialsInClear(authPath)).toEqual([]);
		});

		it("keeps a credential the keyring refuses in clear, moves the others, and resumes on the next run", async () => {
			writeFileSync(authPath, JSON.stringify(plain()));
			vi.stubEnv("FAKE_KEYRING_FAIL_PROVIDER", "openai");
			const first = await migrateToKeyring(authPath);
			expect(first.moved).toEqual(["anthropic"]);
			expect(first.kept.get("openai")).toBe("secret-tool failed: Cannot create an item in a locked collection");
			expect(file().openai).toEqual({ type: "api_key", key: KEY });

			vi.stubEnv("FAKE_KEYRING_FAIL_PROVIDER", "");
			expect(await migrateToKeyring(authPath)).toEqual({ moved: ["openai"], kept: new Map() });
			expect(file().openai).toEqual(marker("api_key"));
		});

		it("keeps a credential in clear when the keyring gives back another value, and removes that item", async () => {
			const before = JSON.stringify({ openai: { type: "api_key", key: KEY } });
			writeFileSync(authPath, before);
			vi.stubEnv("FAKE_KEYRING_CORRUPT", "1");
			expect((await migrateToKeyring(authPath)).kept.get("openai")).toBe("the keyring gave back another value");
			expect(readFileSync(authPath, "utf8")).toBe(before);
			expect(items()).toEqual([]);
		});

		it("writes nothing without a keyring", async () => {
			const before = JSON.stringify(plain());
			writeFileSync(authPath, before);
			vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "");
			expect((await migrateToKeyring(authPath)).kept.get("openai")).toBe(
				"the keyring is not available in this session",
			);
			expect(readFileSync(authPath, "utf8")).toBe(before);
		});

		it("recovers from a run stopped between the keyring and auth.json: the file's value wins", async () => {
			// A first run stored a value, then stopped before writing auth.json; the key changed since.
			writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "sk-stale-0123456789" } }));
			await migrateToKeyring(authPath);
			writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: KEY } }));
			forgetKeyringCredentials();
			expect((await migrateToKeyring(authPath)).moved).toEqual(["openai"]);
			expect(items()).toHaveLength(1);
			forgetKeyringCredentials();
			expect(await AuthStorage.create(authPath).read("openai")).toEqual({ type: "api_key", key: KEY });
		});

		it("asks for a confirmation in the page before moving anything", async () => {
			initTheme("prism");
			setKeybindings(new KeybindingsManager({}));
			setLanguage("fr");
			try {
				writeFileSync(authPath, JSON.stringify(plain()));
				const closed: boolean[] = [];
				const page = new MigrationPage({
					entries: () => credentialsInClear(authPath),
					migrate: () => migrateToKeyring(authPath),
					requestRender() {},
					done: (changed) => void closed.push(changed),
				});
				const screen = () => page.render(64).map((line) => stripAnsi(line).trimEnd());
				expect(screen()).toContain("  openai · Clé d’API");
				expect(screen()).toContain("Entrée déplace 2 identifiant(s) vers le trousseau · Échap retour");
				page.handleInput("\r");
				expect(screen().join(" ")).toContain("Déplacer 2 identifiant(s) vers le trousseau ? Entrée confirme,");
				page.handleInput("\x1b");
				expect(screen().join(" ")).not.toContain("Entrée confirme");
				expect(file().openai).toEqual({ type: "api_key", key: KEY });

				page.handleInput("\r");
				page.handleInput("\r");
				// The move runs secret-tool without blocking: wait for its result, not a fixed time (slow under load).
				expect(screen().join(" ")).toContain("Déplacement vers le trousseau…");
				await vi.waitFor(() => expect(screen()).toContain("Déplacés vers le trousseau : anthropic, openai"), {
					timeout: 10_000,
				});
				expect(file().openai).toEqual(marker("api_key"));
				page.handleInput("\r");
				expect(closed).toEqual([true]);
				for (const line of page.render(64)) expect(stripAnsi(line).length).toBeLessThanOrEqual(64);
			} finally {
				setLanguage("en");
			}
		});
	});

	// fork: the keyring and auth.json are not one transaction. A write of
	// auth.json that fails after the keyring was changed must lose no credential; an unused item may stay.
	describe("a write of auth.json that fails after the keyring changed", () => {
		const failNextRename = () => {
			atomicWriteHooks.beforeRename = () => {
				atomicWriteHooks.beforeRename = undefined;
				throw new Error("disk full (simulated)");
			};
		};
		afterEach(() => {
			atomicWriteHooks.beforeRename = undefined;
		});
		const saved = () => ({ openai: marker("api_key") });

		it("keeps a removed provider's item until auth.json no longer names it", async () => {
			await AuthStorage.create(authPath).modify("openai", async () => ({ type: "api_key", key: KEY }));
			failNextRename();
			await expect(AuthStorage.create(authPath).delete("openai")).rejects.toThrow("disk full");
			expect(file()).toEqual(saved());
			expect(items()).toHaveLength(1);
			forgetKeyringCredentials();
			expect(await AuthStorage.create(authPath).read("openai")).toEqual({ type: "api_key", key: KEY });

			await AuthStorage.create(authPath).delete("openai");
			expect(file()).toEqual({});
			expect(items()).toEqual([]);
		});

		it("keeps the stored key when replacing it by a reference fails", async () => {
			await AuthStorage.create(authPath).modify("openai", async () => ({ type: "api_key", key: KEY }));
			failNextRename();
			await expect(
				AuthStorage.create(authPath).modify("openai", async () => ({ type: "api_key", key: "$OPENAI_KEY" })),
			).rejects.toThrow("disk full");
			forgetKeyringCredentials();
			expect(await AuthStorage.create(authPath).read("openai")).toEqual({ type: "api_key", key: KEY });
		});

		it("reads the refreshed tokens the keyring already holds when auth.json could not be written", async () => {
			const tokens = (n: number) => ({
				type: "oauth" as const,
				access: `a-${n}-0123456789`,
				refresh: `r-${n}-0123456789`,
				expires: n,
			});
			const storage = AuthStorage.create(authPath);
			await storage.modify("anthropic", async () => tokens(1));
			failNextRename();
			await expect(storage.modify("anthropic", async () => tokens(2))).rejects.toThrow("disk full");
			expect(file()).toEqual({ anthropic: marker("oauth") });
			// The same process, then another one: the keyring's newer value, never the dropped one.
			expect(await storage.read("anthropic")).toEqual(tokens(2));
			forgetKeyringCredentials();
			expect(await AuthStorage.create(authPath).read("anthropic")).toEqual(tokens(2));
		});

		it("leaves an unused item for a new provider whose save failed, and the next save takes it over", async () => {
			failNextRename();
			await expect(
				AuthStorage.create(authPath).modify("openai", async () => ({ type: "api_key", key: KEY })),
			).rejects.toThrow("disk full");
			expect(existsSync(authPath) ? file() : {}).toEqual({});
			expect(items()).toHaveLength(1);
			expect(keyringState(authPath).stored.has("openai")).toBe(false);

			await AuthStorage.create(authPath).modify("openai", async () => ({ type: "api_key", key: `${KEY}-2` }));
			expect(file()).toEqual(saved());
			expect(items()).toHaveLength(1);
			forgetKeyringCredentials();
			expect(await AuthStorage.create(authPath).read("openai")).toEqual({ type: "api_key", key: `${KEY}-2` });
		});

		it("keeps the migrated credentials in clear when auth.json could not be written, then resumes", async () => {
			const original = JSON.stringify({ openai: { type: "api_key", key: KEY } });
			writeFileSync(authPath, original);
			failNextRename();
			await expect(migrateToKeyring(authPath)).rejects.toThrow("disk full");
			expect(readFileSync(authPath, "utf8")).toBe(original);
			expect(keyringState(authPath).stored.has("openai")).toBe(false);
			expect((await migrateToKeyring(authPath)).moved).toEqual(["openai"]);
			expect(file()).toEqual(saved());
			expect(items()).toHaveLength(1);
		});
	});
});
