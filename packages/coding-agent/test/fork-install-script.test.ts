// fork: the site installer (fork/scripts/install.sh) never adopts a directory it did not create
//.
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { desktopEntry } from "../src/fork/launch-interface.ts";

const INSTALLER = fileURLToPath(new URL("../../../fork/scripts/install.sh", import.meta.url));

describe("fork: install.sh", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-install-script-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it.runIf(process.platform === "linux" && process.arch === "x64")(
		"refuses an existing directory without the installer's marker, before downloading anything",
		() => {
			const installDir = join(dir, "install");
			mkdirSync(join(installDir, "versions", "keep"), { recursive: true });
			const result = spawnSync("sh", [INSTALLER], {
				encoding: "utf-8",
				env: {
					...process.env,
					HOME: dir,
					PRISM_INSTALL_DIR: installDir,
					PRISM_BIN_DIR: join(dir, "bin"),
					// Unreachable: the refusal must come before any download.
					PRISM_BASE_URL: "http://127.0.0.1:9",
				},
			});
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("was not created by the Prism installer");
			expect(existsSync(join(installDir, "versions", "keep"))).toBe(true);
		},
	);
	// fork: a relative PRISM_INSTALL_DIR is resolved from where the installer
	// runs, so the command's link in BIN_DIR does not point at a path relative to BIN_DIR.
	it.runIf(process.platform === "linux" && process.arch === "x64")(
		"takes a relative installation directory from where it runs",
		() => {
			mkdirSync(join(dir, "work", "install", "versions", "keep"), { recursive: true });
			const result = spawnSync("sh", [INSTALLER], {
				cwd: join(dir, "work"),
				encoding: "utf-8",
				env: {
					...process.env,
					HOME: dir,
					PRISM_INSTALL_DIR: "./install",
					PRISM_BIN_DIR: join(dir, "bin"),
					PRISM_BASE_URL: "http://127.0.0.1:9",
				},
			});
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(`${join(dir, "work")}/./install exists but was not created`);
		},
	);
	// the agent's desktop needs labwc; a first install names the package, an install with it says nothing.
	it.runIf(process.platform === "linux")("names labwc when the agent's desktop cannot start without it", () => {
		const lines = readFileSync(INSTALLER, "utf-8").split("\n");
		// The functions only: main runs on the last line.
		writeFileSync(join(dir, "functions.sh"), lines.filter((line) => line !== 'main "$@"').join("\n"));
		const bin = join(dir, "bin");
		mkdirSync(bin);
		for (const tool of ["sh", "awk", "cat"]) {
			const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).stdout.trim();
			symlinkSync(found, join(bin, tool));
		}
		const run = () =>
			spawnSync(join(bin, "sh"), ["-c", `. ${join(dir, "functions.sh")}; INSTALL_DIR=${dir}; desktop_libraries`], {
				encoding: "utf-8",
				env: { PATH: bin },
				stdio: ["ignore", "pipe", "pipe"],
			});
		const without = run();
		expect(without.status).toBe(0);
		expect(without.stdout).toMatch(/the agent's desktop \(off by default, \/settings > Modules\) needs labwc/);
		writeFileSync(join(bin, "labwc"), "#!/bin/sh\n");
		chmodSync(join(bin, "labwc"), 0o755);
		expect(run().stdout).toBe("");
	});
	// the portal helper (the user's desktop under GNOME and KDE) needs libei and PipeWire; a first
	// install names the missing libraries and the packages, an install with them says nothing.
	it.runIf(process.platform === "linux")("names libei and PipeWire when the portal helper misses them", () => {
		const osRelease = join(dir, "os-release");
		const lines = readFileSync(INSTALLER, "utf-8").split("\n");
		// package_command reads /etc/os-release: this test gives it a throwaway Fedora one.
		writeFileSync(
			join(dir, "functions.sh"),
			lines
				.filter((line) => line !== 'main "$@"')
				.join("\n")
				.replaceAll("/etc/os-release", osRelease)
				.replaceAll("/var/lib/apt/lists", join(dir, "lists")),
		);
		const bin = join(dir, "bin");
		mkdirSync(bin);
		for (const tool of ["sh", "awk", "cat"]) {
			const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).stdout.trim();
			symlinkSync(found, join(bin, tool));
		}
		mkdirSync(join(dir, "current", "desktop"), { recursive: true });
		writeFileSync(join(dir, "current", "desktop", "prism-portal-helper"), "");
		chmodSync(join(dir, "current", "desktop", "prism-portal-helper"), 0o755);
		const ldd = (output: string) => {
			writeFileSync(join(bin, "ldd"), `#!/bin/sh\ncat <<'EOF'\n${output}\nEOF\n`);
			chmodSync(join(bin, "ldd"), 0o755);
		};
		const run = () =>
			spawnSync(join(bin, "sh"), ["-c", `. ${join(dir, "functions.sh")}; INSTALL_DIR=${dir}; portal_libraries`], {
				encoding: "utf-8",
				env: { PATH: bin },
				stdio: ["ignore", "pipe", "pipe"],
			});
		writeFileSync(osRelease, "ID=fedora\n");
		ldd("\tlibei.so.1 => not found\n\tlibpipewire-0.3.so.0 => not found\n\tlibc.so.6 => /lib64/libc.so.6 (0x0)");
		const without = run();
		expect(without.status, without.stderr).toBe(0);
		expect(without.stdout).toContain("needs libraries this system does not have: libei.so.1 libpipewire-0.3.so.0");
		expect(without.stdout).toContain("install them with: sudo dnf install libei pipewire-libs glib2 libxkbcommon");
		// Debian 12 and Ubuntu 22.04 have no libei package: apt would refuse the whole command, so none is offered.
		writeFileSync(osRelease, "ID=debian\n");
		mkdirSync(join(dir, "lists"));
		writeFileSync(join(dir, "lists", "deb.debian.org_debian_dists_bookworm_main_binary-amd64_Packages"), "");
		const aptCache = (known: boolean) => {
			writeFileSync(join(bin, "apt-cache"), `#!/bin/sh\nexit ${known ? 0 : 100}\n`);
			chmodSync(join(bin, "apt-cache"), 0o755);
		};
		ldd("\tlibei.so.1 => not found\n\tlibc.so.6 => /lib64/libc.so.6 (0x0)");
		aptCache(false);
		const bookworm = run().stdout;
		expect(bookworm).toContain("this system has no libei package (Debian 12, Ubuntu 22.04 and older)");
		expect(bookworm).not.toContain("sudo apt");
		aptCache(true);
		expect(run().stdout).toContain("install them with: sudo apt install libei1 ");
		ldd("\tlibei.so.1 => /lib64/libei.so.1 (0x0)\n\tlibc.so.6 => /lib64/libc.so.6 (0x0)");
		expect(run().stdout).toBe("");
	});
	// fork: --uninstall deleted a user's own prism.desktop, and the icon, when it
	// merely mentioned " --gui" (in a comment); it removes only the entry Prism wrote, marked or written before the mark.
	it.runIf(process.platform === "linux")("removes only Prism's own menu entry on uninstall", () => {
		const lines = readFileSync(INSTALLER, "utf-8").split("\n");
		writeFileSync(join(dir, "functions.sh"), lines.filter((line) => line !== 'main "$@"').join("\n"));
		const data = join(dir, "data");
		const entry = join(data, "applications", "prism.desktop");
		const icon = join(data, "icons/hicolor/256x256/apps/prism.png");
		const removed = (text: string) => {
			mkdirSync(join(data, "applications"), { recursive: true });
			mkdirSync(join(data, "icons/hicolor/256x256/apps"), { recursive: true });
			writeFileSync(entry, text);
			writeFileSync(icon, "png");
			const run = spawnSync("sh", ["-c", `. ${join(dir, "functions.sh")}; remove_menu_entry`], {
				encoding: "utf-8",
				env: { PATH: process.env.PATH, HOME: dir, XDG_DATA_HOME: data },
			});
			expect(run.status, run.stderr).toBe(0);
			expect(existsSync(icon)).toBe(existsSync(entry));
			return !existsSync(entry);
		};
		expect(
			removed(
				"[Desktop Entry]\nType=Application\nName=Prism\nComment=My wrapper around prism --gui\nExec=my-prism\n",
			),
		).toBe(false);
		// As a release writes it: named Prism (a source checkout is named after its own config).
		const written = desktopEntry(["/opt/prism/prism"], "prism").replace(/^Name=.*$/m, "Name=Prism");
		expect(removed(written)).toBe(true);
		// fork.10 wrote neither the marker nor the window's class.
		const legacy = written.replace("X-Prism-Menu=true\n", "").replace("StartupWMClass=prism-gui\n", "");
		expect(removed(legacy)).toBe(true);
		expect(removed(legacy.replace("Comment=AI coding agent", "Comment=Mine"))).toBe(false);
	});
	// fork: --check only reports; an installation whose prism cannot say its
	// version gets an explanation, never a download.
	it.runIf(process.platform === "linux" && process.arch === "x64")(
		"--check never downloads a release when the installed version cannot be read",
		() => {
			const installDir = join(dir, "install");
			const release = join(installDir, "versions", "broken");
			mkdirSync(release, { recursive: true });
			writeFileSync(join(installDir, ".prism-install"), "");
			writeFileSync(join(release, "prism"), "#!/bin/sh\nexit 1\n");
			chmodSync(join(release, "prism"), 0o755);
			symlinkSync(release, join(installDir, "current"));
			const bin = join(dir, "fake-bin");
			mkdirSync(bin);
			const calls = join(dir, "curl-calls");
			writeFileSync(join(bin, "curl"), `#!/bin/sh\necho "$@" >> ${calls}\nexit 7\n`);
			chmodSync(join(bin, "curl"), 0o755);
			const result = spawnSync("sh", [INSTALLER, "--check"], {
				encoding: "utf-8",
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					HOME: dir,
					PRISM_INSTALL_DIR: installDir,
					PRISM_BIN_DIR: join(dir, "bin"),
					PRISM_BASE_URL: "http://127.0.0.1:9",
					PRISM_VERSION: "1.0.0-fork.99",
				},
			});
			expect(existsSync(calls)).toBe(false);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("cannot tell which version is installed");
			expect(result.stderr).toContain("1.0.0-fork.99");
		},
	);
});

// canaries are signed with their own key, held by the build server; the
// installer trusts it for canaries only, and the release key for stable releases only.
describe("fork: install.sh, one key per channel", () => {
	/** A minisign key pair, in minisign's formats: the public key line, and a signer for "ED" (prehashed) signatures. */
	function minisignKey() {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		const id = randomBytes(8);
		const raw = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
		const signFile = (data: Buffer, comment: string) => {
			const signature = sign(null, createHash("blake2b512").update(data).digest(), privateKey as KeyObject);
			const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey as KeyObject);
			return [
				"untrusted comment: test",
				Buffer.concat([Buffer.from("ED"), id, signature]).toString("base64"),
				`trusted comment: ${comment}`,
				global.toString("base64"),
				"",
			].join("\n");
		};
		return { publicKey: Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64"), signFile };
	}

	it.runIf(process.platform === "linux")(
		"verifies a release with its channel's key only, with openssl and minisign",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "prism-install-keys-"));
			try {
				const stable = minisignKey();
				const canary = minisignKey();
				const lines = readFileSync(INSTALLER, "utf-8").split("\n");
				writeFileSync(
					join(dir, "functions.sh"),
					lines
						.filter((line) => line !== 'main "$@"')
						.map((line) =>
							line.startsWith("PRISM_PUBLIC_KEY=")
								? `PRISM_PUBLIC_KEY=${stable.publicKey}`
								: line.startsWith("PRISM_CANARY_PUBLIC_KEY=")
									? `PRISM_CANARY_PUBLIC_KEY=${canary.publicKey}`
									: line,
						)
						.join("\n"),
				);
				const sums = Buffer.from("0000  prism-1.0.0-fork.12-linux-x64.tar.gz\n");
				writeFileSync(join(dir, "SHA256SUMS"), sums);
				writeFileSync(join(dir, "by-stable.minisig"), stable.signFile(sums, "prism 1.0.0-fork.12"));
				writeFileSync(join(dir, "by-canary.minisig"), canary.signFile(sums, "prism 1.0.0-fork.12"));
				const hasMinisign = spawnSync("sh", ["-c", "command -v minisign"]).status === 0;
				const verify = (verifier: string, signature: string, channel: string) =>
					spawnSync(
						"sh",
						[
							"-c",
							`. ./functions.sh; mkdir -p w; ${verifier} SHA256SUMS ${signature} w "$(release_key ${channel})"`,
						],
						{ cwd: dir, encoding: "utf-8" },
					);
				for (const verifier of ["verify_openssl", ...(hasMinisign ? ["verify_signature"] : [])]) {
					const stableOk = verify(verifier, "by-stable.minisig", "stable");
					expect(stableOk.status, verifier).toBe(0);
					expect(stableOk.stdout.trim()).toBe("prism 1.0.0-fork.12");
					expect(verify(verifier, "by-canary.minisig", "canary").status, verifier).toBe(0);
					// The canary key cannot sign a stable release, nor the release key a canary.
					expect(verify(verifier, "by-canary.minisig", "stable").status, verifier).not.toBe(0);
					expect(verify(verifier, "by-stable.minisig", "canary").status, verifier).not.toBe(0);
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
