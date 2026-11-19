/**
 * the shortcut that takes the user's desktop back from the agent,
 * changed in `/settings` > Computer use while the desktop module runs (`desktopTakeBackKey` in
 * settings.json, as before). It is declared to Hyprland when the agent takes the desktop, so a change applies from
 * the next time it does.
 */
import { saveGlobalSetting } from "../global-settings.ts";
import { fill, t } from "../i18n/index.ts";
import { paged } from "../settings-pages.ts";
import type { SettingsSection } from "../settings-sections.ts";
import { parseShortcut } from "./hyprland.ts";

export const TAKE_BACK_SETTING = "desktop-take-back-key";

/** The setting's section; `current()` reads the shortcut in effect (the default when none is saved). */
export function takeBackSection(current: () => string, agentDir?: string): SettingsSection {
	const description =
		"The keys that take your desktop back from the agent under Hyprland; moving the mouse for about 2 seconds also does. Applies the next time the agent takes your desktop.";
	return {
		domain: "computer-use",
		items: (context) => [
			{
				id: TAKE_BACK_SETTING,
				label: "Desktop take-back shortcut",
				description,
				currentValue: current(),
				...paged((value, done) => ({
					kind: "input",
					input: {
						title: "Desktop take-back shortcut",
						description: fill(
							"{0} A modifier (ctrl, shift, alt or super) and a letter, a digit or F1 to F12, such as ctrl+shift+q. Empty: back to the default.",
							t(description),
						),
						current: value,
						parse: (text) => {
							try {
								parseShortcut(text);
								return text.toLowerCase().replace(/\s+/g, "");
							} catch (error) {
								return error instanceof Error ? error : new Error(String(error));
							}
						},
						save: (next) => saveGlobalSetting(["desktopTakeBackKey"], next, agentDir),
						requestRender: context.requestRender,
						// The row's value is read again when the section is rebuilt.
						done: (changed) => done(changed ? "changed" : undefined),
					},
				})),
			},
		],
	};
}
