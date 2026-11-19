// Fork-only switches for upstream features the fork turns off. The values are
// typed as boolean, not literal false, so upstream code behind them stays reachable
// and upstream tests that exercise it directly keep compiling.

import { readGlobalSetting } from "./global-settings.ts";

/** `/bug` sends session reports to the Pi developers (Earendil). */
export const BUG_REPORTS_ENABLED: boolean = false;

/** The `/settings` key that turns off the background refreshes of the pi.dev model catalog. */
export const MODEL_CATALOG_REFRESH_SETTING = "modelCatalogRefresh";

/**
 * Background refreshes of the pi.dev model catalog (at startup, in /model, after /login, at most every 4 hours):
 * on unless `modelCatalogRefresh` is false in the global settings (the committed catalog lags, and a release every few days is not the answer)
 * . Off, the catalog is fetched only when
 * the user asks (`update --models`), as in Prism's first versions.
 */
export function automaticModelCatalogRefresh(): boolean {
	return readGlobalSetting(MODEL_CATALOG_REFRESH_SETTING) !== false;
}
