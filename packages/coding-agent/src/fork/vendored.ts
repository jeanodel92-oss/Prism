// fork: third-party plugins copied unchanged under `vendor/node_modules/` (see
// vendor/README.md) and shipped as built-in extensions. Each one is imported from its file with
// the same module resolution as a file extension, so it runs exactly as the published package.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "../config.ts";
import { importExtensionFactory } from "../core/extensions/loader.ts";
import type { ExtensionFactory } from "../core/extensions/types.ts";
import { KIT_I18N, MENU_I18N, translateKitText, translateMenu, translateUi, UI_I18N } from "./menu-i18n.ts";

/** Directory holding the vendored packages, next to the binary or in the package checkout. */
export function getVendorDir(): string {
	return join(getPackageDir(), "vendor", "node_modules");
}

/** Factory for the plugin entry file at `entry`, relative to the vendored `node_modules`. */
export function vendoredExtension(entry: string): ExtensionFactory {
	return async (pi) => {
		// the Node install ships some plugins prebundled (fork/scripts/prebundle-vendored.mjs),
		// a fork under `../forks/x` as `prebundled/forks/x`.
		const prebundled = join(getVendorDir(), "..", "prebundled", entry.replace(/^\.\.\//, ""));
		const path = existsSync(prebundled) ? prebundled : join(getVendorDir(), entry);
		// the forks of pi-goal and pi-plan-mode translate their menus and dialogs with these.
		(globalThis as Record<symbol, unknown>)[MENU_I18N] ??= translateMenu;
		(globalThis as Record<symbol, unknown>)[UI_I18N] ??= translateUi;
		(globalThis as Record<symbol, unknown>)[KIT_I18N] ??= translateKitText;
		const factory = await importExtensionFactory(path, {
			"@narumitw/pi-tui-kit": join(getVendorDir(), "../forks/pi-tui-kit/index.js"),
		});
		if (!factory) throw new Error(`Bundled plugin does not export an extension factory: ${path}`);
		await factory(pi);
	};
}
