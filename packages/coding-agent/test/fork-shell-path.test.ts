// a window started from the applications menu gets the login shell's PATH.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { startInterface } from "../src/fork/launch-interface.ts";
import { loginShellPath, windowPath } from "../src/fork/shell-path.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "prism-shell-path-"));
	dirs.push(dir);
	return dir;
}

/** A fake login shell: prints noise like an rc file, then runs the -c command with PATH set as a profile would. */
function shell(dir: string, body: string): string {
	const path = join(dir, "fake-shell");
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

describe("fork: the window's PATH", () => {
	it("reads the PATH of the login shell, ignoring what its rc files print", async () => {
		const dir = temp();
		const fake = shell(
			dir,
			`echo 'welcome!'; echo 'rc warning' >&2; PATH=/opt/tools/bin:/usr/bin; eval "$4"; exit 1`,
		);
		expect(await loginShellPath(fake, { PATH: "/usr/bin" })).toBe("/opt/tools/bin:/usr/bin");
	});

	it("puts the login shell's PATH first and keeps the entries Prism received", async () => {
		const dir = temp();
		const fake = shell(dir, `PATH=/home/u/.bun/bin:/usr/bin; eval "$4"`);
		expect(await windowPath({ SHELL: fake, PATH: "/usr/local/bin:/usr/bin" })).toBe(
			"/home/u/.bun/bin:/usr/bin:/usr/local/bin",
		);
	});

	it("falls back to the user folders that exist when the shell fails or hangs", async () => {
		const home = temp();
		for (const folder of [".cargo/bin", ".local/bin"]) mkdirSync(join(home, folder), { recursive: true });
		const failing = shell(temp(), "exit 1");
		const env = { SHELL: failing, PATH: "/usr/local/bin:/usr/bin" };
		expect(await windowPath(env, { home })).toBe(
			`${join(home, ".local/bin")}:${join(home, ".cargo/bin")}:/usr/local/bin:/usr/bin`,
		);
		const hanging = shell(temp(), "sleep 10");
		const started = Date.now();
		expect(await windowPath({ ...env, SHELL: hanging }, { home, timeoutMs: 300 })).toContain(
			join(home, ".local/bin"),
		);
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it("gives the window that PATH only when it starts without a terminal", async () => {
		const root = temp();
		const packageDir = join(root, "node_modules/@earendil-works/pi-coding-agent");
		mkdirSync(packageDir, { recursive: true });
		mkdirSync(join(root, "gui"));
		writeFileSync(join(root, "gui", "prism-gui"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(root, "gui", "prism-gui"), 0o755);
		writeFileSync(join(root, "gui", `${APP_NAME}.png`), "png");
		const paths: Array<string | undefined> = [];
		for (const terminal of [false, true]) {
			await startInterface({
				flag: "window",
				plain: true,
				terminal,
				cwd: root,
				setting: { get: () => "window", set: () => {} },
				ask: async () => undefined,
				say: () => {},
				env: { DISPLAY: ":0", PATH: "/usr/bin" },
				packageDir,
				path: async () => "/home/u/.cargo/bin:/usr/bin",
				open: async (_binary, _cwd, env) => {
					paths.push(env?.PATH);
					return undefined;
				},
			});
		}
		expect(paths).toEqual(["/home/u/.cargo/bin:/usr/bin", "/usr/bin"]);
	});
});
