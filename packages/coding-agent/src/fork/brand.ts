import { APP_NAME } from "../config.ts";

/** Capitalized display form of the configured harness name. */
export const APP_DISPLAY_NAME = APP_NAME[0].toUpperCase() + APP_NAME.slice(1);

/**
 * fork (audit FIN-18): the version people read, "12.1" for 1.0.0-fork.12.1 and "12.2 canary 3" for
 * 1.0.0-fork.12.2.canary.3; a version without the fork suffix (source checkout) stays whole.
 */
export function displayVersion(version: string): string {
	const match = /^\d+\.\d+\.\d+-fork\.(\d+(?:\.\d+)?)(?:[.-]canary\.(\d+))?$/.exec(version);
	if (!match) return version;
	return match[2] ? `${match[1]} canary ${match[2]}` : match[1]!;
}

/** True in a branded build (`prism`), false in the source checkout, which keeps upstream's texts. */
export const IS_BRANDED_BUILD = APP_NAME !== "pi";

/**
 * fork: Prism's logo for the local OAuth callback page: a prism outline, the white beam
 * and the spectrum, like the terminal logo.
 */
export const PRISM_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" aria-hidden="true"><g fill="none" stroke-linecap="round" stroke-width="22"><path stroke="#fafafa" d="M60 470 L250 420"/><path stroke="#f0f0f5" stroke-opacity="0.6" d="M250 420 L400 380"/><path stroke="#e84855" d="M420 372 L760 250"/><path stroke="#f58c3c" d="M420 376 L760 306"/><path stroke="#f5d250" d="M420 380 L760 362"/><path stroke="#5fc86e" d="M420 384 L760 418"/><path stroke="#468ce6" d="M420 388 L760 474"/><path stroke="#965ad2" d="M420 392 L760 530"/><path stroke="#a1a1aa" stroke-linejoin="round" d="M330 150 L150 650 L510 650 Z"/></g></svg>`;

/** /login intro for Radius in a branded build: upstream's service, not part of the harness. */
export const BRANDED_RADIUS_LOGIN_INTRO = `Radius is a service by Earendil Works, the makers of pi, on which ${APP_DISPLAY_NAME} is built`;

/** `--help` line for `update` in a branded build. */
export const BRANDED_UPDATE_COMMAND_LINE = `${APP_NAME} update [source|self]      Update ${APP_DISPLAY_NAME}, extensions or model catalogs`;

/** `update --help` in a branded build: `--self` runs the site installer (src/fork/self-update.ts). */
export function brandedUpdateHelp(usage: string): string {
	return `${usage}

Update ${APP_NAME}, installed packages, or model catalogs. ${APP_DISPLAY_NAME} updates itself only when it was
installed from https://prism.odelserver.space; the new release is checked against its signature first.

Options:
  --self                  Update ${APP_NAME} only (default when no target is given)
  --check                 Only say whether a newer ${APP_NAME} exists
  --rollback              Go back to the previous ${APP_NAME} (again: undo)
  --channel <channel>     Switch to the stable or canary channel and update (canary:
                          experimental releases; back to stable with --channel stable)
  --extensions            Update installed packages only
  --models                Refresh model catalogs only
  --all                   Update ${APP_NAME} and installed packages
  --extension <source>    Update one package only
  -a, --approve           Trust project-local files for this command
  -na, --no-approve       Ignore project-local files for this command

Short forms:
  ${APP_NAME} update                Update ${APP_NAME} only
  ${APP_NAME} update --extensions   Update all extensions
  ${APP_NAME} update --models       Refresh model catalogs only
  ${APP_NAME} update <source>       Update one package
`;
}
