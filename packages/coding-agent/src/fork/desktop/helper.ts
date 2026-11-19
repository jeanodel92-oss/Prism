/**
 * where a desktop helper is: `PRISM_DESKTOP_HELPER` (`PRISM_PORTAL_HELPER` for the portal one), else
 * `desktop/<name>` at the root of a release (next to `gui/`), else the build of a source checkout
 * (`fork/desktop-helper/build.sh`). `prism-portal-helper` drives the user's desktop through the desktop portal.
 */
import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { getPackageDir } from "../../config.ts";

function executable(path: string | undefined): path is string {
	if (!path) return false;
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export type DesktopHelperName = "prism-desktop-helper" | "prism-portal-helper";

export function desktopHelperPath(
	env: NodeJS.ProcessEnv = process.env,
	packageDir = getPackageDir(),
	name: DesktopHelperName = "prism-desktop-helper",
): string {
	const candidates = [
		name === "prism-desktop-helper" ? env.PRISM_DESKTOP_HELPER : env.PRISM_PORTAL_HELPER,
		resolve(packageDir, `../../../desktop/${name}`),
		resolve(packageDir, `../../fork/desktop-helper/build/${name}`),
	];
	const found = candidates.find(executable);
	if (!found) {
		throw new Error(
			`${name} is missing from this installation (from a source checkout: fork/desktop-helper/build.sh).`,
		);
	}
	return found;
}
