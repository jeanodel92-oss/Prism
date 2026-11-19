// fork: the footer's "more…" button. Most commands were reachable only from the
// keyboard; this menu lists the common ones, each with its command so it can be learnt.
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import { t } from "../i18n/index.ts";

export const MORE_MENU: ReadonlyArray<{ label: string; command: string }> = [
	{ label: "Help and shortcuts", command: "help" },
	{ label: "Documentation", command: "docs" },
	{ label: "Tutorial", command: "tutorial" },
	{ label: "Settings", command: "settings" },
	{ label: "Permissions", command: "perm" },
	{ label: "Model", command: "model" },
	{ label: "Session details", command: "session" },
	{ label: "New session", command: "new" },
	{ label: "Resume a session", command: "resume" },
	{ label: "Session tree", command: "tree" },
	{ label: "Export the session", command: "export" },
	{ label: "Compact the context", command: "compact" },
];

/** The entries whose command exists in this session: built in, or registered by a loaded extension. */
export function moreMenuEntries(extensionCommands: ReadonlySet<string>): Array<{ label: string; command: string }> {
	const builtin = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
	return MORE_MENU.filter((entry) => builtin.has(entry.command) || extensionCommands.has(entry.command));
}

/** What `chooseFromMoreMenu` returns for its last entry, which arranges the footer's buttons. */
export const CUSTOMIZE_FOOTER = "customize-footer";

/**
 * Shows the menu; resolves to the chosen command line ("/docs"), CUSTOMIZE_FOOTER, or undefined when dismissed.
 */
export async function chooseFromMoreMenu(
	select: (title: string, options: string[]) => Promise<string | undefined>,
	extensionCommands: ReadonlySet<string>,
): Promise<string | undefined> {
	const entries = moreMenuEntries(extensionCommands);
	const options = entries.map((entry) => `${t(entry.label)}  /${entry.command}`);
	const customize = t("Footer buttons…");
	const choice = await select(t("More"), [...options, customize]);
	if (choice === customize) return CUSTOMIZE_FOOTER;
	const entry = choice === undefined ? undefined : entries[options.indexOf(choice)];
	return entry ? `/${entry.command}` : undefined;
}
