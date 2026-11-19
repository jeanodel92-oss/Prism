import type { SettingsManager } from "./settings-manager.ts";

// fork: install telemetry and provider attribution headers are always off,
// regardless of PI_TELEMETRY or the enableInstallTelemetry setting.
export function isInstallTelemetryEnabled(_settingsManager: SettingsManager, _telemetryEnv?: string): boolean {
	return false;
}
