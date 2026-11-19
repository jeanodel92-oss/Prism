// Shared runtime state between the header, composer, statusline and title.
import type { ExtensionContext } from "../../../core/extensions/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { AnimationId, AnimationStyle } from "../../animations.ts";
import type { ContextInfo } from "../footer-actions.ts";

export interface PrismState {
	/** Latest extension context (refreshed on every event). */
	ctx?: ExtensionContext;
	/** pi's live theme proxy: always resolves to the active theme. */
	theme?: Theme;
	thinkingLevel: string;
	/** Epoch ms when the current agent run started, undefined when idle. */
	workingSince?: number;
	/** Git branch, mirrored from the footer data provider. */
	branch: () => string | null | undefined;
	/** Set by the composer once pi mounts it. */
	requestRender: () => void;
	/** fork: runs a command (e.g. "perm", "plan") from a click; set by the extension. */
	openCommand?: (command: string) => void;
	/**
	 * fork: runs a slash command line as if typed in the composer, built-in commands included;
	 * set by the composer. A draft in the composer is kept.
	 */
	submitCommand?: (line: string) => void;
	/** fork: opens the footer's "more…" menu; set by the extension. */
	openMenu?: () => void;
	/**
	 * fork: runs a command of the "more…" menu ("settings"), built-in or from an extension;
	 * set by the extension.
	 */
	runAction?: (command: string) => void;
	/** fork: the commands pinned to the footer that exist in this session, in their order. */
	footerActions?: () => readonly string[];
	/** the context gauge opens /context; set by the extension. */
	openContext?: (info: ContextInfo) => void;
	/** the gauge's latest figures, for what /context says of auto-compaction; set by the extension. */
	contextSeen?: (info: ContextInfo) => void;
	/** fork: moves to the next thinking level the model supports; set by the extension. */
	cycleThinking?: () => void;
	/** fork: toggles Plan mode, undefined when the Plan mode extension is not loaded. */
	togglePlan?: () => void;
	/** fork: which switches the composer shows (their extension is loaded). */
	modes: { plan: boolean; goal: boolean; files: boolean };
	/** fork: Plan mode's toggle key, shown next to its switch. */
	planShortcut?: () => string | undefined;
	/** fork: extension statuses, mirrored from the footer data provider. */
	statuses: () => ReadonlyMap<string, string>;
	/** >0 while a menu renders inside a prism dialog frame. */
	framing: number;
	/** fork: whether animation `id` moves (an interactive terminal, the `animations` settings). */
	animates: (id: AnimationId) => boolean;
	animationStyle: (id: AnimationId) => AnimationStyle;
	/** fork: the `interfaceMode` setting; simple drops technical details, advanced shows them. */
	interfaceMode: () => "simple" | "advanced";
}

export function createState(): PrismState {
	return {
		thinkingLevel: "off",
		branch: () => undefined,
		statuses: () => new Map(),
		modes: { plan: false, goal: false, files: false },
		requestRender: () => {},
		framing: 0,
		animates: () => false,
		animationStyle: () => "default",
		interfaceMode: () => "simple",
	};
}
