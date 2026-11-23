/**
 * fork: settings that built-in extensions add to `/settings`, and the way their commands open it.
 *
 * `/settings` is drawn by the interactive mode, but some settings belong to built-in extensions (the permission
 * gate and its sandbox, notifications, budgets, language and MCP servers). Each extension adds its section here
 * while its session runs and removes it at shutdown, so a module turned off leaves nothing behind. The
 * interactive mode sets the host, which opens the window on a domain or a setting: `/perm`, `/sandbox`
 * and the other commands kept as shortcuts call `openSettings`.
 * Same pattern as the onboarding host (onboarding.ts).
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SettingItem } from "@earendil-works/pi-tui";

/** What a section may ask of the open window. */
export interface SectionContext {
	/** Whether the advanced interface is on (a page leaves technical rows out otherwise). */
	advanced(): boolean;
	/** Draws the window again, for an answer that arrives later, such as a server's values. */
	requestRender(): void;
	/**
	 * fork: the saved default model, read and changed as the Models domain's "Default model" does, so a
	 * page that removes the default can offer another one. Undefined when the window has no Models domain.
	 */
	defaultModel?: {
		get(): { provider: string; id: string } | undefined;
		set(model: Model<Api>): void;
	};
}

/** Settings an extension adds to one domain of `/settings`. */
export interface SettingsSection {
	/** The domain id (settings-domains.ts), such as "permissions" or "notifications". */
	domain: string;
	/** The section's settings, built when `/settings` opens and again after one of them changes. */
	items(context: SectionContext): SettingItem[];
	/** Rows found only by the search, such as one model's setting (they open the right page). */
	searchItems?(context: SectionContext): SettingItem[];
	/** Called when one of the section's settings changes. */
	onChange?(id: string, value: string): void | Promise<void>;
	/** Whether a setting is shown only in the advanced interface. */
	isAdvanced?(id: string): boolean;
}

const sections = new Map<string, SettingsSection>();

/** Adds (or, with undefined, removes) the section of `owner`; a reload replaces it. */
export function setSettingsSection(owner: string, section: SettingsSection | undefined): void {
	if (section) sections.set(owner, section);
	else sections.delete(owner);
}

/** The sections in the order their owners added them. */
export function settingsSections(): SettingsSection[] {
	return [...sections.values()];
}

/** Where `/settings` opens: a domain, and in it a setting to focus. */
export interface SettingsTarget {
	domain: string;
	item?: string;
	/** Open that setting too: its page, its list or its choices. */
	open?: boolean;
}

let host: ((target: SettingsTarget) => void) | undefined;

/** Set by the interactive mode; unset outside it (print, RPC), where commands keep their text output. */
export function setSettingsHost(next: ((target: SettingsTarget) => void) | undefined): void {
	host = next;
}

/** Opens `/settings` on `target`; false when there is no window to open (no interactive mode). */
export function openSettings(target: SettingsTarget): boolean {
	if (!host) return false;
	host(target);
	return true;
}
