import { APP_NAME } from "../config.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";
import { applyBrandedEnvAliases } from "../fork/branded-cli.ts";

export function setupCli(): void {
	process.title = APP_NAME;
	// fork (FIN-04): PRISM_OFFLINE, PRISM_PACKAGE_DIR and PRISM_SHARE_VIEWER_URL alias the PI_* names.
	applyBrandedEnvAliases(APP_NAME);
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = "pi";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	// Configure undici before provider SDKs issue requests. Settings are applied
	// once SettingsManager has loaded global/project configuration.
	configureHttpDispatcher();
}
