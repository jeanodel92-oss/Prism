/**
 * fork: prism-portal-helper typed a whole batch of keys before honouring the
 * take-back shortcut, whose D-Bus signal waits on the same GLib loop: 200 characters went on for about 3 s after the
 * user pressed it. fork/desktop-helper/tests/portal-take-back.c drives the helper's own code without a portal.
 * Skipped without gcc and the helper's development files.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const source = fileURLToPath(new URL("../../../fork/desktop-helper/tests/portal-take-back.c", import.meta.url));
const libraries = ["gio-unix-2.0", "libei-1.0", "libpipewire-0.3", "xkbcommon"];

function buildFlags(): string[] | undefined {
	try {
		execFileSync("sh", ["-c", "command -v gcc"], { stdio: "ignore" });
		return execFileSync("pkg-config", ["--cflags", "--libs", ...libraries], { encoding: "utf8" })
			.trim()
			.split(/\s+/);
	} catch {
		return undefined;
	}
}

const flags = buildFlags();
const dir = mkdtempSync(join(tmpdir(), "prism-take-back-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!flags)("prism-portal-helper take-back during a batch of keys", () => {
	it("stops typing at the shortcut and lets go of the keys it held", () => {
		const binary = join(dir, "portal-take-back");
		execFileSync("gcc", [
			"-std=c11",
			"-O2",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-Wno-unused-parameter",
			"-Wno-unused-function",
			"-o",
			binary,
			source,
			...(flags ?? []),
		]);
		const run = spawnSync(binary, ["100"], { encoding: "utf8", timeout: 20_000 });
		if (run.status === 77) return; // no xkb keyboard data on this machine
		expect(run.status).toBe(4);
		const lines = run.stdout.trim().split("\n");
		// The batch never finished: no "ok".
		expect(lines).not.toContain("ok");
		const keys = lines.filter((line) => line.startsWith("key "));
		// Shift down, then a few "a" in 100 ms; the old code sent all 402 events (3.2 s of pauses) first.
		expect(keys.length).toBeGreaterThan(2);
		expect(keys.length).toBeLessThan(100);
		// Nothing stays held: every key pressed was let go, Shift included.
		const held = new Set<string>();
		for (const line of keys) {
			const [, code, state] = line.split(" ");
			if (state === "down") held.add(code);
			else held.delete(code);
		}
		expect([...held]).toEqual([]);
	});
});
