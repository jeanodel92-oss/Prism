/**
 * fork: an installation stays usable
 * whatever else runs. One installer at a time changes it, a release a running process came from is not
 * pruned, a channel switch without a new release leaves the rollback pair alone, and the local
 * installer keeps the previous installation until the new one is in place.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const INSTALLER = fileURLToPath(new URL("../../../fork/scripts/install.sh", import.meta.url));
const LOCAL_INSTALLER = fileURLToPath(new URL("../../../fork/scripts/install-local.sh", import.meta.url));
const linuxX64 = process.platform === "linux" && process.arch === "x64";
const hasFlock = spawnSync("sh", ["-c", "command -v flock"]).status === 0;

let dir: string;
let installDir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "prism-installers-"));
	installDir = join(dir, "install");
});

afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	rmSync(dir, { recursive: true, force: true });
});

/** A release directory whose prism answers `--version` with `version`. */
function release(name: string, version: string): string {
	const path = join(installDir, "versions", name);
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "prism"), `#!/bin/sh\necho ${version}\n`);
	chmodSync(join(path, "prism"), 0o755);
	return path;
}

/** An installation on S2 (canary channel) whose previous release is S1 (stable). */
function installation(): void {
	release("s1", "1.0.0-fork.1");
	release("s2", "1.0.0-fork.2");
	writeFileSync(join(installDir, ".prism-install"), "");
	symlinkSync("versions/s2", join(installDir, "current"));
	symlinkSync("versions/s1", join(installDir, "previous"));
	writeFileSync(join(installDir, "channel"), "canary\n");
	writeFileSync(join(installDir, "previous-channel"), "stable\n");
}

function installerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: dir,
		PRISM_INSTALL_DIR: installDir,
		PRISM_BIN_DIR: join(dir, "bin"),
		// Unreachable: none of these cases downloads anything.
		PRISM_BASE_URL: "http://127.0.0.1:9",
		...extra,
	};
}

describe("fork: install.sh, one installation at a time", () => {
	it.runIf(linuxX64 && hasFlock)("waits for another installer before changing the installation", async () => {
		installation();
		const ready = join(dir, "ready");
		const seen = join(dir, "seen");
		// Another installer holds the lock; when it lets go, it notes where current points.
		const holder = spawn("flock", [
			`${installDir}.lock`,
			"sh",
			"-c",
			`touch '${ready}'; sleep 1.5; readlink '${installDir}/current' > '${seen}'`,
		]);
		children.push(holder);
		while (!existsSync(ready)) await new Promise((done) => setTimeout(done, 20));
		const rollback = spawn("sh", [INSTALLER, "--rollback"], { env: installerEnv() });
		children.push(rollback);
		let output = "";
		rollback.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		const code = await new Promise((done) => rollback.on("exit", done));
		if (holder.exitCode === null) await new Promise((done) => holder.on("exit", done));
		expect(code).toBe(0);
		expect(readFileSync(seen, "utf-8").trim()).toBe("versions/s2");
		expect(readlinkSync(join(installDir, "current"))).toBe("versions/s1");
		expect(output).toContain("waiting for another Prism installation");
	});

	it.runIf(process.platform === "linux")("keeps a release a running process was started from", () => {
		release("a", "1.0.0-fork.1");
		release("b", "1.0.0-fork.2");
		release("c", "1.0.0-fork.3");
		release("d", "1.0.0-fork.4");
		symlinkSync("versions/c", join(installDir, "current"));
		symlinkSync("versions/b", join(installDir, "previous"));
		// A session still running from release a, two updates ago: its program is the release's own node. A copy of this
		// node, not of `sleep`: where one program serves every coreutils tool under its name (Ubuntu 26.04, the CI
		// runner), a copy named `node` exits at once.
		mkdirSync(join(installDir, "versions", "a", "node", "bin"), { recursive: true });
		const node = join(installDir, "versions", "a", "node", "bin", "node");
		copyFileSync(process.execPath, node);
		chmodSync(node, 0o755);
		const session = spawn(node, ["-e", "setTimeout(() => {}, 30000)"]);
		children.push(session);
		const lines = readFileSync(INSTALLER, "utf-8").split("\n");
		writeFileSync(join(dir, "functions.sh"), lines.filter((line) => line !== 'main "$@"').join("\n"));
		const result = spawnSync(
			"sh",
			["-c", `. '${join(dir, "functions.sh")}'; INSTALL_DIR='${installDir}'; prune_versions`],
			{
				encoding: "utf-8",
			},
		);
		expect(result.status).toBe(0);
		expect(existsSync(join(installDir, "versions", "a"))).toBe(true);
		expect(existsSync(join(installDir, "versions", "b"))).toBe(true);
		expect(existsSync(join(installDir, "versions", "c"))).toBe(true);
		expect(existsSync(join(installDir, "versions", "d"))).toBe(false);
	});

	it.runIf(linuxX64 && hasFlock)(
		"a channel switch without a new release keeps the channel of the previous release (CR-020)",
		() => {
			installation();
			const result = spawnSync("sh", [INSTALLER, "--update", "--channel", "stable"], {
				encoding: "utf-8",
				env: installerEnv({ PRISM_VERSION: "1.0.0-fork.2" }),
			});
			expect(result.status, result.stderr).toBe(0);
			expect(readFileSync(join(installDir, "channel"), "utf-8").trim()).toBe("stable");
			expect(readFileSync(join(installDir, "previous-channel"), "utf-8").trim()).toBe("stable");
			expect(readlinkSync(join(installDir, "previous"))).toBe("versions/s1");
		},
	);
});

describe("fork: install-local.sh", () => {
	it.runIf(linuxX64)("keeps the previous installation when the new one cannot be put in place", () => {
		mkdirSync(installDir, { recursive: true });
		writeFileSync(join(installDir, ".prism-install"), "");
		writeFileSync(join(installDir, "prism"), "#!/bin/sh\necho old\n");
		// Stand-ins for node and for the move of the new installation into place, which fails.
		const bin = join(dir, "fake-bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "node"),
			`#!/bin/sh
case $1 in
-p) [ "$2" = process.execPath ] && echo /usr/bin/node || echo 1.0.0-fork.1 ;;
*node-install.mjs) mkdir -p "$2/node_modules/@earendil-works/pi-coding-agent" ;;
esac
exit 0
`,
		);
		const realMv = spawnSync("sh", ["-c", "command -v mv"], { encoding: "utf-8" }).stdout.trim();
		writeFileSync(
			join(bin, "mv"),
			`#!/bin/sh\ncase "$*" in *.new.*" ${installDir}") touch '${join(dir, "mv-refused")}'; exit 1 ;; esac\nexec ${realMv} "$@"\n`,
		);
		chmodSync(join(bin, "node"), 0o755);
		chmodSync(join(bin, "mv"), 0o755);
		const result = spawnSync("bash", [LOCAL_INSTALLER, "--skip-build"], {
			encoding: "utf-8",
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				HOME: dir,
				PRISM_INSTALL_DIR: installDir,
				PRISM_BIN_DIR: join(dir, "bin"),
			},
		});
		expect(result.status).not.toBe(0);
		// It got as far as moving the new installation in: the stand-in mv refused that move, nothing earlier.
		expect(existsSync(join(dir, "mv-refused"))).toBe(true);
		expect(readFileSync(join(installDir, "prism"), "utf-8")).toContain("echo old");
		expect(existsSync(join(installDir, ".prism-install"))).toBe(true);
		expect(readdirSync(dir).filter((name) => name.startsWith("install."))).toEqual([]);
	});
});
