// fork: `prism update` for an installation made by the site installer.
//
// The installer (fork/scripts/install.sh) lays out
//   <install dir>/versions/<release>/   one directory per release, with its own install.sh
//   <install dir>/current, previous     links switched by rename
// and does the work: signature and checksum checks, the atomic switch, rollback.
// `prism update` runs the copy of install.sh shipped in the running release, so the
// public key it trusts comes from the release already installed, not from the network.
//
// fork: two channels. The installer keeps the installation's channel in
// <install dir>/channel; `prism update --channel stable|canary` switches. Canary releases
// are versioned <upstream>-fork.<n>.canary.<m>, so the running version names its channel.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { APP_NAME, getPackageDir } from "../config.ts";
import { isNewerPackageVersion } from "../utils/version-check.ts";
import { readGlobalSetting } from "./global-settings.ts";
import { hostCommand, hostPath } from "./host-program.ts";
import { t } from "./i18n/index.ts";

const MARKER = ".prism-install";
export const SITE_URL = "https://prism.odelserver.space";

/**
 * how Prism updates itself. manual (default): it asks the site only
 * when the user runs /update or `prism update`; notify: it checks at start and says so; auto: it checks at start and
 * installs, and the new version opens at the next start.
 */
export const UPDATE_MODE_SETTING = "updateMode";
export type UpdateMode = "manual" | "notify" | "auto";

export function updateMode(): UpdateMode {
	const value = readGlobalSetting(UPDATE_MODE_SETTING);
	return value === "notify" || value === "auto" ? value : "manual";
}

export type SelfUpdateMode = "update" | "check" | "rollback";
export type ReleaseChannel = "stable" | "canary";

export interface SelfUpdateRequest {
	mode: SelfUpdateMode;
	channel?: ReleaseChannel;
}

/** A canary release names itself: <upstream>-fork.<n>.canary.<m> (same test as install.sh). */
export function isCanaryVersion(version: string): boolean {
	return version.includes(".canary.");
}

/** The warning a canary release shows at each start (its risks stay visible). */
export function canaryNotice(): string {
	return t(
		`Canary channel: this release is experimental and can break. Back to stable: ${APP_NAME} update --channel stable`,
	);
}

/** The channel the installer recorded for this installation; stable when there is none. */
export function readReleaseChannel(install: ReleaseInstall): ReleaseChannel {
	try {
		return readFileSync(join(install.installDir, "channel"), "utf8").split("\n")[0].trim() === "canary"
			? "canary"
			: "stable";
	} catch {
		return "stable";
	}
}

export interface ReleaseInstall {
	installDir: string;
	installer: string;
}

/** The site installation the package at `packageDir` belongs to, if any. */
export function findReleaseInstall(packageDir: string = getPackageDir()): ReleaseInstall | undefined {
	if (!existsSync(packageDir)) return undefined;
	// <release>/node_modules/@earendil-works/pi-coding-agent
	const release = resolve(realpathSync(packageDir), "..", "..", "..");
	const versions = dirname(release);
	const installDir = dirname(versions);
	const installer = join(release, "install.sh");
	if (basename(versions) !== "versions" || !existsSync(join(installDir, MARKER)) || !existsSync(installer)) {
		return undefined;
	}
	return { installDir, installer };
}

/** Runs the installer in `mode` (on `channel`, when switching) with inherited output; returns the exit code. */
export function runPrismUpdate(mode: SelfUpdateMode, install = findReleaseInstall(), channel?: ReleaseChannel): number {
	if (!install) {
		console.error(
			`This ${APP_NAME} was not installed from ${SITE_URL}, so it cannot update itself. Install it from there with:\n  curl -fsSL ${SITE_URL}/install.sh | sh`,
		);
		return 1;
	}
	const args = [install.installer, `--${mode}`, ...(channel ? ["--channel", channel] : [])];
	// fork: `sh` and the programs the installer runs by name, never from where
	// the sandbox writes.
	const result = spawnSync(hostCommand("sh"), args, {
		stdio: "inherit",
		env: { ...process.env, PATH: hostPath(), PRISM_INSTALL_DIR: install.installDir },
	});
	return result.status ?? 1;
}

/**
 * `update --check`, `update --rollback` and `update --channel stable|canary` (alone or with
 * `--check`), which upstream's parser does not know.
 */
export function getSelfUpdateRequest(args: string[]): SelfUpdateRequest | undefined {
	if (args[0] !== "update") return undefined;
	let mode: SelfUpdateMode = "update";
	let channel: ReleaseChannel | undefined;
	for (let index = 1; index < args.length; index++) {
		const arg = args[index];
		if ((arg === "--check" || arg === "--rollback") && mode === "update")
			mode = arg === "--check" ? "check" : "rollback";
		else if (arg === "--channel" && !channel && (args[index + 1] === "stable" || args[index + 1] === "canary"))
			channel = args[++index] as ReleaseChannel;
		else return undefined;
	}
	if (mode === "rollback" && channel) return undefined;
	return mode === "update" && !channel ? undefined : { mode, channel };
}

/**
 * The latest version the site offers on the installation's channel (canary: the newer of the canary and stable
 * lists); undefined when the site cannot be reached or lists nothing valid. `prism update` checks signatures.
 */
export async function latestPrismRelease(
	install: ReleaseInstall,
	fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
	if (process.env.PI_OFFLINE) return undefined;
	try {
		const baseUrl = process.env.PRISM_BASE_URL || SITE_URL;
		const lists = readReleaseChannel(install) === "canary" ? ["LATEST", "LATEST-canary"] : ["LATEST"];
		let newest: string | undefined;
		for (const list of lists) {
			const response = await fetchImpl(`${baseUrl}/releases/${list}`, { signal: AbortSignal.timeout(5000) });
			if (!response.ok) continue;
			const latest = (await response.text()).split("\n")[0].trim();
			if (!/^[0-9A-Za-z.+-]+$/.test(latest) || (list === "LATEST" && isCanaryVersion(latest))) continue;
			if (!newest || isNewerPackageVersion(latest, newest)) newest = latest;
		}
		return newest;
	} catch {
		return undefined;
	}
}

/** The newer version the site offers on the installation's channel, if any. Silent on any failure. */
export async function checkForPrismUpdate(
	currentVersion: string,
	install = findReleaseInstall(),
	fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
	if (!install) return undefined;
	const newest = await latestPrismRelease(install, fetchImpl);
	return newest && isNewerPackageVersion(newest, currentVersion) ? newest : undefined;
}

/** The version the installation's `current` link points to: the one the next start runs. */
export function installedPrismVersion(install: ReleaseInstall): string | undefined {
	try {
		const manifest = join(install.installDir, "current", "node_modules", "@earendil-works", "pi-coding-agent");
		const version = (JSON.parse(readFileSync(join(manifest, "package.json"), "utf8")) as { version?: unknown })
			.version;
		return typeof version === "string" ? version : undefined;
	} catch {
		return undefined;
	}
}

/** Whether the installation has a version to go back to (`prism update --rollback`). */
export function hasPreviousPrism(install: ReleaseInstall): boolean {
	return existsSync(join(install.installDir, "previous", "prism"));
}

/** Runs the installer with `args`, its output captured rather than shown: the agent's own screen keeps drawing. */
export function runPrismInstaller(install: ReleaseInstall, args: string[]): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		const child = spawn(hostCommand("sh"), [install.installer, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PATH: hostPath(), PRISM_INSTALL_DIR: install.installDir },
		});
		let output = "";
		const collect = (chunk: Buffer) => {
			output = (output + chunk.toString("utf8")).slice(-8000);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("error", (error) => resolve({ ok: false, output: error.message }));
		child.on("close", (code) => resolve({ ok: code === 0, output }));
	});
}
