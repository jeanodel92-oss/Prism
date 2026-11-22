// Prism's updates from inside Prism. Manual by default; notify and
// auto check at start at most once an hour; /update installs, switches channel and goes back.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_NAME, ENV_AGENT_DIR, VERSION } from "../src/config.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { type ReleaseInstall, runPrismUpdate, systemPackageManager } from "../src/fork/self-update.ts";
import { claimAutomaticCheck, startupUpdate, updateCommand } from "../src/fork/updates.ts";

const NEWER = "99.0.0-fork.1";

let dir: string;
let install: ReleaseInstall;

/** A site installation whose installer records its arguments and, on --update, installs NEWER. */
function fakeInstall(installed = VERSION): ReleaseInstall {
	const installDir = join(dir, "prism");
	const pkg = join(installDir, "current", "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: installed }));
	const installer = join(dir, "install.sh");
	writeFileSync(
		installer,
		`#!/bin/sh
echo "$@" >> "${join(dir, "calls")}"
case "$1" in --update) printf '{"version":"${NEWER}"}' > "${join(pkg, "package.json")}"; echo "prism-install: updated" ;; esac
`,
	);
	chmodSync(installer, 0o755);
	return { installDir, installer };
}

function context(answers: { select?: (options: string[]) => string | undefined; confirm?: boolean } = {}) {
	const notices: string[] = [];
	const titles: string[] = [];
	const offered: string[][] = [];
	const ctx = {
		hasUI: true,
		ui: {
			notify: (message: string) => notices.push(message),
			select: async (title: string, options: string[]) => {
				titles.push(title);
				offered.push(options);
				return answers.select?.(options);
			},
			confirm: async () => answers.confirm ?? false,
		},
	} as unknown as ExtensionContext;
	return { ctx, notices, titles, offered };
}

const calls = () => {
	try {
		return readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
	} catch {
		return [];
	}
};

function settings(value: Record<string, unknown>) {
	writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify(value));
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "prism-updates-"));
	mkdirSync(join(dir, "agent"));
	vi.stubEnv(ENV_AGENT_DIR, join(dir, "agent"));
	vi.stubEnv("PI_OFFLINE", "");
	install = fakeInstall();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(`${NEWER}\n`)),
	);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

describe("fork: updates at start", () => {
	it("asks nothing in manual mode, the default", async () => {
		const { ctx, notices } = context();
		await startupUpdate(ctx, install);
		expect(fetch).not.toHaveBeenCalled();
		expect(notices).toEqual([]);
	});

	it("says a newer version exists in notify mode, without installing it", async () => {
		settings({ updateMode: "notify" });
		const { ctx, notices } = context();
		await startupUpdate(ctx, install);
		expect(notices).toEqual([`Prism ${NEWER} is available. /update installs it.`]);
		expect(calls()).toEqual([]);
	});

	it("installs it in auto mode, for the next start, and checks at most once an hour", async () => {
		settings({ updateMode: "auto" });
		const first = context();
		await startupUpdate(first.ctx, install);
		expect(calls()).toEqual(["--update"]);
		expect(first.notices.at(-1)).toBe(`Prism ${NEWER} is installed: it opens at the next start.`);

		// Installed but not running yet: the next start in the hour says so without asking the site.
		vi.mocked(fetch).mockClear();
		const second = context();
		await startupUpdate(second.ctx, install);
		expect(fetch).not.toHaveBeenCalled();
		expect(second.notices).toEqual([`Prism ${NEWER} is installed: it opens at the next start.`]);
	});

	it("claims one automatic check an hour per installation", () => {
		const now = Date.now();
		expect(claimAutomaticCheck(install, now)).toBe(true);
		expect(claimAutomaticCheck(install, now + 10 * 60 * 1000)).toBe(false);
		expect(claimAutomaticCheck(install, now + 61 * 60 * 1000)).toBe(true);
	});
});

describe("fork: /update", () => {
	it("offers the newer version, the canary channel and closing; installs on request", async () => {
		const { ctx, titles, offered, notices } = context({ select: (options) => options[0] });
		await updateCommand(ctx, install);
		expect(titles[0]).toBe(`Prism ${VERSION}, stable channel. Prism ${NEWER} is available.`);
		expect(offered[0]).toEqual([
			`Install Prism ${NEWER}`,
			"Switch to the canary channel (experimental, can break)",
			"Close",
		]);
		expect(calls()).toEqual(["--update"]);
		expect(notices.at(-1)).toBe(`Prism ${NEWER} is installed: it opens at the next start.`);
	});

	it("switches to canary only after the warning is accepted", async () => {
		const pick = (options: string[]) => options.find((option) => option.startsWith("Switch to the canary"));
		await updateCommand(context({ select: pick, confirm: false }).ctx, install);
		expect(calls()).toEqual([]);
		await updateCommand(context({ select: pick, confirm: true }).ctx, install);
		expect(calls()).toEqual(["--update --channel canary"]);
	});

	it("offers stable back on canary, and the previous version when there is one", async () => {
		writeFileSync(join(install.installDir, "channel"), "canary\n");
		mkdirSync(join(install.installDir, "previous"));
		writeFileSync(join(install.installDir, "previous", "prism"), "");
		const pick = (options: string[]) => options.find((option) => option.startsWith("Go back"));
		const { offered } = context();
		const run = context({ select: pick });
		await updateCommand(run.ctx, install);
		expect(run.offered[0]).toContain("Back to the stable channel");
		expect(calls()).toEqual(["--rollback"]);
		expect(offered).toEqual([]);
	});

	it("says when the site cannot be reached, and when Prism was not installed from it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("down", { status: 503 })),
		);
		const offline = context();
		await updateCommand(offline.ctx, install);
		expect(offline.titles[0]).toBe(
			`Prism ${VERSION}, stable channel. https://prism.odelserver.space could not be reached.`,
		);

		const elsewhere = context();
		await updateCommand(elsewhere.ctx, undefined);
		expect(elsewhere.notices[0]).toContain("cannot update itself");
	});
});

// fork: a deb or rpm package leaves its updates to apt or dnf, so two updaters never fight.
describe("fork: a Prism installed by a system package", () => {
	/** A release laid out as a package installs it, with the package's marker at its root. */
	function packagedRelease(marker?: string): string {
		const release = join(dir, "opt", "prism");
		const pkg = join(release, "node_modules", "@earendil-works", "pi-coding-agent");
		mkdirSync(pkg, { recursive: true });
		if (marker !== undefined) writeFileSync(join(release, ".prism-package"), marker);
		return pkg;
	}

	it("names the package manager from the marker, and only a plain name", () => {
		expect(systemPackageManager(packagedRelease("dnf\n"))).toBe("dnf");
		rmSync(join(dir, "opt"), { recursive: true });
		expect(systemPackageManager(packagedRelease())).toBeUndefined();
		rmSync(join(dir, "opt"), { recursive: true });
		expect(systemPackageManager(packagedRelease("apt; rm -rf ~\n"))).toBeUndefined();
	});

	it("/update sends to the package manager and never runs the installer", async () => {
		const { ctx, notices, offered } = context({ select: (options) => options[0] });
		await updateCommand(ctx, install, "apt");
		expect(notices).toEqual([
			`This ${APP_NAME} was installed by apt: update it with apt, which keeps it with the rest of the system.`,
		]);
		expect(offered).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
		expect(calls()).toEqual([]);
	});

	it("/update sends an AppImage to the downloads page", async () => {
		const { ctx, notices } = context({ select: (options) => options[0] });
		await updateCommand(ctx, install, "appimage");
		expect(notices).toEqual([
			`This ${APP_NAME} is an AppImage: download the new one from https://prism.odelserver.space/downloads/ and replace this file with it.`,
		]);
		expect(fetch).not.toHaveBeenCalled();
		expect(calls()).toEqual([]);
	});

	it("auto mode installs nothing at start", async () => {
		settings({ updateMode: "auto" });
		const { ctx, notices } = context();
		await startupUpdate(ctx, install, "dnf");
		expect(fetch).not.toHaveBeenCalled();
		expect(notices).toEqual([]);
		expect(calls()).toEqual([]);
	});

	it("prism update refuses with the same message", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(runPrismUpdate("update", install, undefined, "dnf")).toBe(1);
		expect(error).toHaveBeenCalledWith(
			`This ${APP_NAME} was installed by dnf: update it with dnf, which keeps it with the rest of the system.`,
		);
		expect(calls()).toEqual([]);
		error.mockRestore();
	});
});
