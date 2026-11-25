// pi-prism: visual layer only. Header, composer, statusline, transcript
// styling and title spinner; no commands, tools or behaviour changes.
// fork: copy of fork/reference/pi-prism/extensions, shipped as the built-in extension
// `builtin:prism`. Changes from the reference: relative imports, lint and erasable-syntax fixes,
// and the footer flag below is set when the extension loads, not when the module is imported.
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { setMarkdownTokenHook } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { ANIMATIONS, type AnimationSettings, animationOn, animationStyle } from "../animations.ts";
import { publishContextBridge } from "../context-bridge.ts";
import { saveGlobalSetting } from "../global-settings.ts";
import { fill, getLanguage } from "../i18n/index.ts";
import { THINKING_UNSUPPORTED } from "../model-settings.ts";
import { planBridge } from "../plan-bridge.ts";
import { setRenderHooks } from "../render-hooks.ts";
import { openSettings } from "../settings-sections.ts";
import { installTutorial } from "../tutorial.ts";
import { dialogFrameHook } from "./dialogs.ts";
import { createEditorFactory } from "./editor.ts";
import { createFooterFactory } from "./footer.ts";
import {
	autoCompactionLine,
	type ContextInfo,
	customizeFooter,
	FOOTER_ACTIONS_SETTING,
	readFooterActions,
} from "./footer-actions.ts";
import { createHeaderFactory } from "./header.ts";
import { createState, type PrismState } from "./lib/state.ts";
import { CUSTOMIZE_FOOTER, chooseFromMoreMenu, moreMenuEntries } from "./more-menu.ts";
import { noticeHooks } from "./notices.ts";
import { createTitleSpinner } from "./title.ts";
import { markdownTokenHook, transcriptHooks } from "./transcript.ts";
import { transitionHooks } from "./transitions.ts";
import { installTurnSummary } from "./turn-summary.ts";

// in its own module, so /init (project-continuity.ts) reads it without importing this one.
export { planBridge } from "../plan-bridge.ts";

export default function prism(pi: ExtensionAPI) {
	// pi-codex-usage checks this flag: when set it publishes its quota data for
	// our statusline instead of replacing the footer with its own.
	(globalThis as Record<symbol, unknown>)[Symbol.for("pi-prism.footer")] = true;
	const state = createState();
	const title = createTitleSpinner(state);
	// fork: read again at most once a second, so a change in /settings shows without a reload.
	let mode: { at: number; value: "simple" | "advanced" } | undefined;
	state.interfaceMode = () => {
		const now = Date.now();
		if (!mode || now - mode.at > 1000) {
			let value: "simple" | "advanced" = "simple";
			try {
				value = pi.getSettings().interfaceMode === "advanced" ? "advanced" : "simple";
			} catch {}
			mode = { at: now, value };
		}
		return mode.value;
	};
	// fork: the animation switches, read again at most once a second like the interface mode.
	let tty = false;
	let motion: { at: number; settings: AnimationSettings } | undefined;
	const motionSettings = () => {
		const now = Date.now();
		if (!motion || now - motion.at > 1000) {
			let settings: AnimationSettings = {};
			try {
				settings = pi.getSettings();
			} catch {}
			motion = { at: now, settings };
		}
		return motion.settings;
	};
	state.animates = (id) => tty && animationOn(motionSettings(), id);
	state.animationStyle = (id) => animationStyle(motionSettings().animationStyles, id);
	// fork: render hooks instead of prototype patches; cleared on shutdown, and set again
	// when a reload or a new session loads the extension.
	// what the transcript hooks read besides the component, so finished messages are decorated once.
	// computed once per frame, not once per message: a frame renders every
	// message synchronously, and at 5000 messages the per-message key took 1.8 s of a 12 s streamed reply.
	// A theme or language changed within the same tick still gives a new key.
	let frameKey: unknown[] | undefined;
	const cacheKey = () => {
		const language = getLanguage();
		if (!frameKey || frameKey[0] !== state.theme || frameKey.at(-1) !== language) {
			if (!frameKey)
				queueMicrotask(() => {
					frameKey = undefined;
				});
			frameKey = [
				state.theme,
				state.theme?.name,
				state.interfaceMode(),
				...ANIMATIONS.map(({ id }) => state.animates(id)),
				...ANIMATIONS.map(({ id }) => state.animationStyle(id)),
				language,
			];
		}
		return frameKey;
	};
	setRenderHooks({
		...transcriptHooks(state),
		...noticeHooks(state),
		...transitionHooks(state), // fork
		dialogFrame: dialogFrameHook(state),
		cacheKey,
	});
	setMarkdownTokenHook(markdownTokenHook(state));

	const sync = (ctx: ExtensionContext) => {
		state.ctx = ctx;
		if (!state.theme && ctx.hasUI) state.theme = ctx.ui.theme;
	};

	installModeSwitches(pi, state);
	installTurnSummary(pi, state); // the end of each turn
	installTutorial(pi, state); // /tutorial

	pi.on("session_start", async (_event, ctx) => {
		sync(ctx);
		if (!ctx.hasUI) return;
		state.thinkingLevel = pi.getThinkingLevel?.() ?? "off";
		// fork: the logo is drawn in only in an interactive terminal and when animations are on.
		tty = process.stdout.isTTY === true;
		const header = createHeaderFactory(state, state.animates("intro"));
		const footer = createFooterFactory(state);
		ctx.ui.setHeader((tui) => {
			title.attach(tui);
			return header(tui);
		});
		ctx.ui.setFooter((tui, theme, data) => {
			title.attach(tui);
			return footer(tui, theme, data);
		});
		ctx.ui.setEditorComponent(createEditorFactory(state));
	});

	pi.on("model_select", async (_event, ctx) => sync(ctx));
	pi.on("thinking_level_select", async (event, ctx) => {
		state.thinkingLevel = event.level ?? state.thinkingLevel;
		sync(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => {
		sync(ctx);
		state.workingSince ??= Date.now();
		title.start();
	});
	pi.on("agent_settled", async (_event, ctx) => {
		sync(ctx);
		state.workingSince = undefined;
		title.stop();
	});
	pi.on("session_shutdown", async () => {
		state.workingSince = undefined;
		title.stop();
		setRenderHooks({});
		setMarkdownTokenHook(undefined);
	});
}

/**
 * fork: the mode switches of the composer and statusline (Plan, Goal, thinking level,
 * permissions) act through these, so a click does what the key or the command does.
 */
export function installModeSwitches(pi: ExtensionAPI, state: PrismState): void {
	const notify = (message: string) => state.ctx?.ui.notify(message, "info");
	state.openCommand = (command) => {
		const name = command.split(" ")[0];
		if (!pi.getCommands().some((entry) => entry.source === "extension" && entry.name === name)) {
			notify(fill("/{0} is not available in this session.", name));
			return;
		}
		void pi.sendUserMessage(`/${command}`, { expandPromptTemplates: true });
	};
	const extensionCommands = () =>
		new Set(
			pi
				.getCommands()
				.filter((entry) => entry.source === "extension")
				.map((entry) => entry.name),
		);
	// fork: built-in commands go through the composer's submit path.
	state.runAction = (command) => {
		if (state.submitCommand) state.submitCommand(`/${command}`);
		else state.openCommand?.(command);
	};
	// fork: the pinned commands, read again at most every 2 s so a hand edit shows.
	let pinned: { at: number; names: string[] } | undefined;
	state.footerActions = () => {
		const now = Date.now();
		if (!pinned || now - pinned.at > 2000) pinned = { at: now, names: readFooterActions() };
		const available = new Set(moreMenuEntries(extensionCommands()).map((entry) => entry.command));
		return pinned.names.filter((name) => available.has(name));
	};
	const select = (title: string, options: string[]) => state.ctx!.ui.select(title, options);
	// fork: the footer's "more…" menu.
	state.openMenu = () => {
		const ctx = state.ctx;
		if (!ctx?.hasUI) return;
		void chooseFromMoreMenu(select, extensionCommands()).then((line) => {
			if (line === CUSTOMIZE_FOOTER) {
				void customizeFooter(select, extensionCommands(), readFooterActions(), (names) => {
					try {
						saveGlobalSetting([FOOTER_ACTIONS_SETTING], names);
					} catch (error) {
						ctx.ui.notify(
							fill(
								"Could not save the footer buttons: {0}",
								error instanceof Error ? error.message : String(error),
							),
							"error",
						);
						return false;
					}
					pinned = { at: Date.now(), names };
					state.requestRender();
					return true;
				});
			} else if (line) state.runAction?.(line.slice(1));
		});
	};
	// the context gauge opens /context, as in the window; /context says how
	// auto-compaction runs and offers /compact and its settings (context-bridge.ts), as the gauge's menu did.
	let context: ContextInfo | undefined;
	state.openContext = (info) => {
		context = info;
		if (state.ctx?.hasUI) state.runAction?.("context");
	};
	state.contextSeen = (info) => {
		context = info;
	};
	publishContextBridge({
		compaction: () => (context ? autoCompactionLine(context) : undefined),
		threshold: () => (context?.auto === false ? null : context?.threshold),
		compact: () => state.runAction?.("compact"),
		settings: () => void openSettings({ domain: "conversation", item: "compaction-threshold" }),
	});
	state.cycleThinking = () => {
		const model = state.ctx?.model;
		if (!model?.reasoning) {
			notify(THINKING_UNSUPPORTED);
			return;
		}
		const levels = getSupportedThinkingLevels(model);
		const next = levels[(levels.indexOf(pi.getThinkingLevel()) + 1) % levels.length];
		if (next) pi.setThinkingLevel(next);
	};
	// Each switch shows only when its extension is loaded, checked once the session has started.
	pi.on("session_start", async () => {
		const names = new Set(
			pi
				.getCommands()
				.filter((entry) => entry.source === "extension")
				.map((entry) => entry.name),
		);
		state.modes = { plan: names.has("plan"), goal: names.has("goal"), files: names.has("files") };
	});
	state.togglePlan = () => {
		const bridge = planBridge();
		if (bridge && state.ctx) bridge.toggle(state.ctx);
		else state.openCommand?.("plan");
	};
	state.planShortcut = () => planBridge()?.shortcut;
	// pi-goal has no key of its own: app.goal.menu (alt+g by default, src/fork/command-keys.ts) opens its menu
	// (start, pause, resume or clear a goal).
}
