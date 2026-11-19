// fork: a command that changed the settings reports whether they reached the
// disk, instead of a success while settings.json still holds the old configuration.
import chalk from "chalk";
import type { SettingsManager } from "../core/settings-manager.ts";

/** Waits for the settings writes, prints those that failed, and says whether all were saved. */
export async function settingsSaved(settingsManager: SettingsManager): Promise<boolean> {
	await settingsManager.flush();
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors)
		console.error(chalk.red(`The ${scope} settings could not be saved: ${error.message}`));
	return errors.length === 0;
}
