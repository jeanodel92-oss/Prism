// fork: the footer's actions. Commands of the "more…" menu can be pinned to the footer,
// in the order chosen, saved in the global settings.json; those that do not fit stay in the menu. The context
// gauge opens /context, which says how auto-compaction runs (autoCompactionLine).
import { readGlobalSetting } from "../global-settings.ts";
import { fill, t } from "../i18n/index.ts";
import { MORE_MENU, moreMenuEntries } from "./more-menu.ts";

export const FOOTER_ACTIONS_SETTING = "footerActions";

/** The pinned commands, in their order; names that are not in the "more…" menu are left out. */
export function readFooterActions(agentDir?: string): string[] {
	const value = readGlobalSetting(FOOTER_ACTIONS_SETTING, agentDir);
	if (!Array.isArray(value)) return [];
	const known = new Set(MORE_MENU.map((entry) => entry.command));
	return [...new Set(value.filter((name): name is string => typeof name === "string" && known.has(name)))];
}

type Select = (title: string, options: string[]) => Promise<string | undefined>;

/**
 * Pin, unpin and move the footer's commands, one menu per step, until Esc. `save` stores the new list and
 * returns false when it could not.
 */
export async function customizeFooter(
	select: Select,
	extensionCommands: ReadonlySet<string>,
	pinned: readonly string[],
	save: (pinned: string[]) => boolean,
): Promise<void> {
	let current = [...pinned];
	for (;;) {
		const entries = moreMenuEntries(extensionCommands);
		const options = entries.map((entry) => {
			const at = current.indexOf(entry.command);
			const mark = at < 0 ? "  " : `${at + 1} `;
			return `${mark}${t(entry.label)}  /${entry.command}`;
		});
		const title = `${t("Footer buttons")}\n${t("Numbered commands show in the footer, in that order; those that do not fit stay in more….")}`;
		const choice = await select(title, options);
		const entry = choice === undefined ? undefined : entries[options.indexOf(choice)];
		if (!entry) return;
		const at = current.indexOf(entry.command);
		const actions =
			at < 0
				? [t("Pin to the footer")]
				: [
						t("Remove from the footer"),
						...(at > 0 ? [t("Move left")] : []),
						...(at < current.length - 1 ? [t("Move right")] : []),
					];
		const action = await select(`${t(entry.label)}  /${entry.command}`, actions);
		if (action === undefined) continue;
		const next = [...current];
		if (action === t("Pin to the footer")) next.push(entry.command);
		else if (action === t("Remove from the footer")) next.splice(at, 1);
		else {
			const to = action === t("Move left") ? at - 1 : at + 1;
			[next[at], next[to]] = [next[to]!, next[at]!];
		}
		if (save(next)) current = next;
	}
}

export interface ContextInfo {
	percent: number | null;
	/** The context window in tokens; 0 when it is not known. */
	window: number;
	/** No model is configured. */
	noModel?: boolean;
	auto: boolean;
	/** Where auto-compaction starts, in percent of the window. */
	mark?: number;
	/** fork: the same, in tokens, for /context's buffer. */
	threshold?: number;
}

/** What auto-compaction does here: off, its mark, or "when nearly full". */
export function autoCompactionLine(info: ContextInfo): string {
	if (!info.auto) return t("Auto-compaction is off: the context fills up until you run /compact.");
	if (info.mark === undefined)
		return t("auto: when the context is nearly full, Prism summarises the older messages to make room.");
	return fill(
		"auto: at {0}, Prism summarises the older messages to make room (auto-compaction).",
		`${Math.round(info.mark)}%`,
	);
}
