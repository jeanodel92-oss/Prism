/**
 * Prism's updates from inside Prism, in the terminal and in the
 * window (whose settings and menus are the engine's).
 *
 * `/update` checks the site, then offers what applies: install the newer version, switch between the stable and
 * canary channels, go back to the previous version. The installer does the work as for `prism update` (signature,
 * atomic switch); the version in use keeps running, and the new one opens at the next start.
 *
 * At start, the `updateMode` setting (self-update.ts) decides: manual (default) asks nothing; notify says when a
 * newer version exists; auto installs it. At most one automatic check an hour per installation, so the window's
 * engines, each a process, do not all ask the site or install at once.
 */
import { statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_NAME, VERSION } from "../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { isNewerPackageVersion } from "../utils/version-check.ts";
import { fill, t } from "./i18n/index.ts";
import {
	findReleaseInstall,
	hasPreviousPrism,
	installedPrismVersion,
	latestPrismRelease,
	type ReleaseInstall,
	readReleaseChannel,
	runPrismInstaller,
	SITE_URL,
	updateMode,
} from "./self-update.ts";

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const CHECK_STAMP = "update-checked";

/** Claims this hour's automatic check for the installation; false when another start already made it. */
export function claimAutomaticCheck(install: ReleaseInstall, now = Date.now()): boolean {
	const stamp = join(install.installDir, CHECK_STAMP);
	try {
		if (now - statSync(stamp).mtimeMs < CHECK_INTERVAL_MS) return false;
	} catch {}
	try {
		writeFileSync(stamp, "");
		utimesSync(stamp, now / 1000, now / 1000);
	} catch {
		return false;
	}
	return true;
}

/** A version installed after the one running, which the next start opens. */
function pendingVersion(install: ReleaseInstall): string | undefined {
	const installed = installedPrismVersion(install);
	return installed && installed !== VERSION ? installed : undefined;
}

/** The installer's last line, without its "prism-install:" prefix: what it says it did or why it stopped. */
function lastLine(output: string): string {
	const lines = output
		.split("\n")
		.map((line) => line.replace(/^prism-install:\s*/, "").trim())
		.filter(Boolean);
	return lines.at(-1) ?? t("no message");
}

async function install(ctx: ExtensionContext, target: ReleaseInstall, args: string[], waiting: string): Promise<void> {
	ctx.ui.notify(waiting, "info");
	const result = await runPrismInstaller(target, args);
	const installed = pendingVersion(target);
	if (result.ok && installed) {
		ctx.ui.notify(fill("Prism {0} is installed: it opens at the next start.", installed), "info");
	} else if (result.ok) {
		ctx.ui.notify(lastLine(result.output), "info");
	} else {
		ctx.ui.notify(fill("The update failed: {0}", lastLine(result.output)), "error");
	}
}

/** What the update mode asks for at start. */
export async function startupUpdate(ctx: ExtensionContext, target = findReleaseInstall()): Promise<void> {
	const mode = updateMode();
	if (mode === "manual" || !target || process.env.PI_OFFLINE) return;
	const pending = pendingVersion(target);
	if (pending) {
		ctx.ui.notify(fill("Prism {0} is installed: it opens at the next start.", pending), "info");
		return;
	}
	if (!claimAutomaticCheck(target)) return;
	const latest = await latestPrismRelease(target);
	if (!latest || !isNewerPackageVersion(latest, VERSION)) return;
	if (mode === "notify") {
		ctx.ui.notify(fill("Prism {0} is available. /update installs it.", latest), "info");
		return;
	}
	await install(ctx, target, ["--update"], fill("Installing Prism {0}…", latest));
}

/** `/update`. */
export async function updateCommand(ctx: ExtensionContext, target = findReleaseInstall()): Promise<void> {
	if (!target) {
		ctx.ui.notify(
			fill(
				"This {0} was not installed from {1}, so it cannot update itself. Install it from there with: curl -fsSL {1}/install.sh | sh",
				APP_NAME,
				SITE_URL,
			),
			"warning",
		);
		return;
	}
	const channel = readReleaseChannel(target);
	const pending = pendingVersion(target);
	const latest = await latestPrismRelease(target);
	const newer = latest && isNewerPackageVersion(latest, pending ?? VERSION) ? latest : undefined;
	const status = pending
		? fill("Prism {0} is installed: it opens at the next start.", pending)
		: newer
			? fill("Prism {0} is available.", newer)
			: latest
				? t("Prism is up to date.")
				: fill("{0} could not be reached.", SITE_URL);

	const installNewer = newer ? fill("Install Prism {0}", newer) : undefined;
	const toCanary = t("Switch to the canary channel (experimental, can break)");
	const toStable = t("Back to the stable channel");
	const rollback = t("Go back to the previous version");
	const options = [
		...(installNewer ? [installNewer] : []),
		channel === "stable" ? toCanary : toStable,
		...(hasPreviousPrism(target) ? [rollback] : []),
		t("Close"),
	];
	const title = fill("Prism {0}, {1} channel. {2}", VERSION, t(channel), status);
	const choice = await ctx.ui.select(title, options);
	if (choice === undefined) return;
	if (choice === installNewer) {
		await install(ctx, target, ["--update"], fill("Installing Prism {0}…", newer ?? ""));
	} else if (choice === toCanary) {
		const sure = await ctx.ui.confirm(
			t("Switch to the canary channel?"),
			t(
				"Canary versions are built from each change that passes the tests, before any review: they can break. Your settings are kept, and /update brings you back to stable.",
			),
		);
		if (sure) await install(ctx, target, ["--update", "--channel", "canary"], t("Installing the latest canary…"));
	} else if (choice === toStable) {
		await install(ctx, target, ["--update", "--channel", "stable"], t("Installing the latest stable version…"));
	} else if (choice === rollback) {
		await install(ctx, target, ["--rollback"], t("Going back to the previous version…"));
	}
}

export default function updates(pi: ExtensionAPI): void {
	let started = false;
	pi.on("session_start", async (_event, ctx) => {
		// Once per process: a new session in the same process is not a new start.
		if (started || !ctx.hasUI) return;
		started = true;
		void startupUpdate(ctx);
	});
	pi.registerCommand("update", {
		description: t("Check for a Prism update, switch channel or go back to the previous version"),
		handler: async (_args, ctx) => updateCommand(ctx),
	});
}
