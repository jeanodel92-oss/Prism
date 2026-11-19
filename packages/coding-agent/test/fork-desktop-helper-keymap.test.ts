/**
 * fork: prism-desktop-helper starts a new keymap when a batch of keys does not
 * fit in the current one, but it only resent the keymap when its number of entries changed. Two disjoint batches of
 * 200 keysyms made a new keymap of the same size, never sent: the compositor turned the codes back into the first
 * batch's characters. fork/desktop-helper/tests/keymap-reset.c drives the helper's own code with a fake compositor.
 * Skipped without gcc, wayland-scanner and libwayland-client's development files.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const helperDir = fileURLToPath(new URL("../../../fork/desktop-helper/", import.meta.url));

function buildFlags(): string[] | undefined {
	try {
		execFileSync("sh", ["-c", "command -v gcc && command -v wayland-scanner"], { stdio: "ignore" });
		return execFileSync("pkg-config", ["--cflags", "--libs", "wayland-client"], { encoding: "utf8" })
			.trim()
			.split(/\s+/);
	} catch {
		return undefined;
	}
}

const flags = buildFlags();
const dir = mkdtempSync(join(tmpdir(), "prism-keymap-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!flags)("prism-desktop-helper keymap after a reset", () => {
	it("sends the new keymap when it has as many keys as the previous one", () => {
		const generated: string[] = [];
		for (const file of readdirSync(join(helperDir, "protocols"))) {
			const name = file.replace(/\.xml$/, "");
			const protocol = join(helperDir, "protocols", file);
			execFileSync("wayland-scanner", ["client-header", protocol, join(dir, `${name}-client-protocol.h`)]);
			execFileSync("wayland-scanner", ["private-code", protocol, join(dir, `${name}-protocol.c`)]);
			generated.push(join(dir, `${name}-protocol.c`));
		}
		const binary = join(dir, "keymap-reset");
		execFileSync("gcc", [
			"-std=c11",
			"-O2",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-Wno-unused-parameter",
			"-Wno-unused-function",
			`-I${dir}`,
			"-o",
			binary,
			join(helperDir, "tests", "keymap-reset.c"),
			...generated,
			...(flags ?? []),
		]);
		const run = spawnSync(binary, [], { encoding: "utf8", timeout: 20_000 });
		expect(run.status).toBe(0);
		const lines = run.stdout.trim().split("\n");
		const sent = lines.filter((line) => line.startsWith("sent "));
		const typed = lines.filter((line) => line.startsWith("typed "));
		const keymaps = lines.filter((line) => line.startsWith("keymaps "));
		expect(sent).toHaveLength(2);
		expect(typed.map((line) => line.slice("typed".length))).toEqual(sent.map((line) => line.slice("sent".length)));
		// One keymap per batch: the second did not fit beside the first.
		expect(keymaps).toEqual(["keymaps 1", "keymaps 2"]);
	});
});
