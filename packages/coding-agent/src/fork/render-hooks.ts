// fork: typed render hooks for transcript and menu components.
// The Prism pack used to restyle upstream components by patching their prototypes and by
// replacing methods on the editor's host container. Those patches read private fields, so an
// upstream rename broke the look without any error. Each hooked component now builds a typed
// view of what the hook needs; a rename fails the type check in the upstream file instead.
// A hook returns undefined to fall back to the component's own rendering. No hook is set unless
// the built-in Prism extension is loaded, so the vanilla interface is unchanged.
import type { Component } from "@earendil-works/pi-tui";

/** One block of an assistant message, in render order. */
export interface AssistantBlock {
	component: Component;
	/** "text" is markdown; "notice" is a plain status line (truncation, abort, error). */
	kind: "spacer" | "text" | "thinking" | "thinking-hidden" | "notice";
}

export interface AssistantMessageRender {
	lines: string[];
	/** Height drawn for each block, so mouse hit-testing matches what the hook drew. */
	layout: Array<{ component: Component; height: number }>;
}

export interface ToolExecutionView {
	toolName: string;
	isPartial: boolean;
	isError: boolean;
	/** Whether the details are shown (ctrl+o or a click); the simple interface folds them otherwise. */
	expanded: boolean;
	/** The call's arguments, for the simple interface's one-line description of the action. */
	args: unknown;
	/** "self": the tool draws its own frame; "renderer": call/result renderers; "text": plain output. */
	shell: "self" | "renderer" | "text";
	/** Lines of the self-framed renderer (records their height for mouse dispatch). */
	renderSelf(width: number): string[];
	/** Lines of the call and result renderers, without the surrounding box. */
	renderParts(width: number): string[];
	/** Lines of the plain-text output, including its one-line top and bottom padding. */
	renderText(width: number): string[];
	imageCount: number;
	/** Image spacers and images, as the component draws them below its content. */
	renderImages(width: number): string[];
}

export interface DialogFrame {
	lines: string[];
	/** For each output line, the child's own line index, or -1 for frame chrome. */
	rows: number[];
	/** Width and height the child was rendered at. */
	innerWidth: number;
	innerHeight: number;
	/** Columns of chrome left of the child's content. */
	offsetX: number;
	/** fork: the window's ✕, a click there closes the menu (ctrl+c). */
	close?: { row: number; from: number; to: number };
}

/** fork: a panel opened with a transition. */
export interface PanelTransition {
	/** Folds the panel, then calls `hide`. Keyboard focus should leave the panel first. */
	close(hide: () => void): void;
}

export interface RenderHooks {
	userMessage?: (width: number, renderDefault: (width: number) => string[]) => string[] | undefined;
	assistantMessage?: (
		width: number,
		blocks: readonly AssistantBlock[],
		isStreaming: boolean,
	) => AssistantMessageRender | undefined;
	toolExecution?: (view: ToolExecutionView, width: number) => string[] | undefined;
	dynamicBorder?: (width: number) => string[] | undefined;
	/** Frame for a menu shown in the editor's slot (selectors, extension dialogs). */
	dialogFrame?: (child: Component, width: number) => DialogFrame | undefined;
	/** fork: a warning or error of the transcript (src/fork/notice-text.ts). */
	notice?: (kind: "warning" | "error", message: string, width: number) => string[] | undefined;
	/**
	 * fork: the collapsed startup listing as a summary, given each section's name and
	 * item count (src/fork/loaded-summary.ts). The expanded listing (ctrl+o) stays upstream's.
	 */
	loadedSummary?: (sections: ReadonlyArray<{ name: string; count: number }>, width: number) => string[] | undefined;
	/**
	 * fork: a panel shown over the screen or in place of the editor opens with a transition;
	 * undefined when it opens as is. `open`: it replaces a screen of the same menu, and only folds when it goes.
	 * May replace the component's render and its handleMouse.
	 */
	panel?: (component: Component, open?: boolean) => PanelTransition | undefined;
	/** fork: a click showed or hid the details of this block, before its next render. */
	unfold?: (component: Component, id: "tools" | "thinking") => void;
	/** fork: the rows this block draws, given the rows it would draw (fork/prism/transitions.ts). */
	unfolding?: (component: Component, id: "tools" | "thinking", lines: string[]) => string[];
	/**
	 * fork: what the transcript hooks read besides the component itself (theme, interface mode,
	 * language...), compared value by value. Without it, hooked transcript renders are not cached.
	 */
	cacheKey?: () => readonly unknown[];
}

export const renderHooks: RenderHooks = {};

/** Bumped by setRenderHooks, so a render cached under other hooks is never reused. */
let hooksGeneration = 0;

/** Replace all hooks at once; pass {} to restore the vanilla rendering. */
export function setRenderHooks(hooks: RenderHooks): void {
	hooksGeneration++;
	for (const key of Object.keys(renderHooks) as Array<keyof RenderHooks>) delete renderHooks[key];
	Object.assign(renderHooks, hooks);
}

/**
 * fork: the last hooked render of one transcript component. Every frame renders the whole
 * transcript, so without it each streamed token re-decorated every message (24 ms a frame at 5000
 * messages). The component clears it whenever its content changes, invalidate()
 * included; `renderHooks.cacheKey` covers what the hooks read elsewhere. Nothing is cached while the
 * component is live (streaming, running tool), since its hooked render may animate.
 */
export class HookRenderCache<T> {
	private key: unknown[] | undefined;
	private value: T | undefined;

	clear(): void {
		this.key = undefined;
		this.value = undefined;
	}

	get(width: number, cacheable: boolean, render: () => T): T {
		const env = cacheable ? renderHooks.cacheKey?.() : undefined;
		if (!env) {
			this.clear();
			return render();
		}
		const key = [hooksGeneration, width, ...env];
		const previous = this.key;
		if (previous && previous.length === key.length && previous.every((v, i) => v === key[i])) return this.value as T;
		const value = render();
		this.key = key;
		this.value = value;
		return value;
	}
}
