/**
 * fork: the terminal views of extensions (`ctx.ui.custom`, widget components) for an RPC client.
 *
 * The interactive terminal draws these views itself. In RPC mode `custom()` resolved at once with
 * `undefined`, so `/perm`, `/bg`, `/doctor`, `/files`… did nothing in a client. Here the same components
 * run in the engine, unchanged: they render to lines at the client's size, and the client sends back the
 * keys and mouse events a terminal would. No view logic lives in the client, and whatever a view does
 * goes through the same engine code as in the terminal.
 *
 * A client opts in with `set_views`. Until then nothing changes, so a client that cannot show views is
 * never left with a view waiting for input.
 *
 * Protocol (one JSON object per line, as the rest of RPC mode):
 * - engine → client: `view_open {id, overlay, nativeMenu?}`, `view_frame {id, columns, lines, menu?}` (ANSI lines or a
 *   pi-tui-kit screen definition for a graphical menu),
 *   `view_closed {id, reason}`;
 * - engine → client: `session_state {state}`: what a session whose last turn was cut
 *   short was doing, `null` once the next prompt starts; sent from startup, before `set_views`;
 * - client → engine: `set_views {columns, rows, theme?, nativeMenus?}`, `view_input {viewId, data}` (terminal key
 *   sequences), `view_mouse {viewId, event}` (cells of the view, zero-based), `view_close {viewId}`,
 *   `view_action {viewId, action}` (validated by the menu adapter against the current screen).
 */

import * as crypto from "node:crypto";
import type { Component, OverlayOptions, SizeValue, Terminal, TuiMouseEvent } from "@earendil-works/pi-tui";
import { isFocusable, setCapabilityOverrides, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../core/extensions/types.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { setTheme, theme } from "../modes/interactive/theme/theme.ts";
import { setViewsClient } from "./interactive-client.ts";
import { setSessionStateHost } from "./session-state.ts";

type CustomFactory = Parameters<ExtensionUIContext["custom"]>[0];
type CustomOptions = Parameters<ExtensionUIContext["custom"]>[1];
type WidgetFactory = Exclude<Parameters<ExtensionUIContext["setWidget"]>[1], string[] | undefined>;
type ViewComponent = Component & {
	dispose?(): void;
	nativeMenu?: object;
	handleNativeMenuInput?(input: unknown): boolean;
};
type Output = (record: object) => void;

/** A terminal that is never drawn to: it only gives the views the client's size. */
class ViewTerminal implements Terminal {
	columns = 100;
	rows = 30;
	readonly kittyProtocolActive = false;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

/** The TUI handed to view factories. A render request becomes frames for the client. */
class ViewTui extends TuiMainScreen {
	private readonly onRender: () => void;

	constructor(terminal: ViewTerminal, onRender: () => void) {
		super(terminal);
		this.onRender = onRender;
	}

	protected override doRender(): void {
		this.onRender();
	}
}

const size = (value: SizeValue | undefined, reference: number): number | undefined => {
	if (typeof value === "number") return value;
	const percent = value ? /^(\d+(?:\.\d+)?)%$/.exec(value) : null;
	return percent ? Math.floor((reference * Number.parseFloat(percent[1])) / 100) : undefined;
};

interface OpenView {
	id: string;
	overlay?: OverlayOptions | (() => OverlayOptions);
	component?: ViewComponent;
	lines: string[];
	columns: number;
	/** The last native menu sent, as JSON: a menu that changes while its view stays open is sent again. */
	menu?: string;
	close(result: unknown, reason: "done" | "aborted" | "client"): void;
}

export class RpcViews {
	private readonly output: Output;
	private readonly terminal = new ViewTerminal();
	private readonly tui: ViewTui;
	private keybindings: KeybindingsManager | undefined;
	private readonly views = new Map<string, OpenView>();
	private readonly widgets = new Map<
		string,
		{ component: ViewComponent; lines: string[]; send: (lines: string[]) => void }
	>();

	constructor(output: Output) {
		this.output = output;
		this.tui = new ViewTui(this.terminal, () => this.renderAll());
		setSessionStateHost({ show: (state) => this.output({ type: "session_state", state: state ?? null }) });
	}

	/** the footer's pinned commands changed (while its menu is still open); the client shows them now. */
	footerChanged(pinned: string[]): void {
		this.output({ type: "footer_changed", pinned });
	}

	/** `ctx.ui.custom` once the client shows views; `undefined` (the previous behaviour) otherwise. */
	custom<T>(factory: CustomFactory, options: CustomOptions): Promise<T> {
		const keybindings = this.keybindings;
		const signal = options?.signal;
		if (!keybindings || signal?.aborted) return Promise.resolve(undefined as T);
		const id = crypto.randomUUID();
		return new Promise<T>((resolve, reject) => {
			const onAbort = () => view.close(undefined, "aborted");
			const view: OpenView = {
				id,
				overlay: options?.overlay ? (options.overlayOptions ?? {}) : undefined,
				lines: [],
				columns: 0,
				close: (result, reason) => {
					if (!this.views.delete(id)) return;
					signal?.removeEventListener("abort", onAbort);
					this.output({ type: "view_closed", id, reason });
					try {
						view.component?.dispose?.();
					} catch {
						// As in the terminal, a view that fails to dispose does not hold its result back.
					}
					resolve(result as T);
				},
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.views.set(id, view);
			const nativeMenu = options && "nativeMenu" in options && options.nativeMenu === true;
			this.output({
				type: "view_open",
				id,
				overlay: Boolean(options?.overlay),
				...(nativeMenu ? { nativeMenu: true } : {}),
			});
			// onHandle is not called: there is no overlay stack to hide or refocus. Its users treat the
			// handle as optional (the questionnaire's collapse key then does nothing).
			// fork: a factory that throws at once takes the same cleanup path as
			// one that rejects later.
			new Promise<Awaited<ReturnType<CustomFactory>>>((ready) =>
				ready(factory(this.tui, theme, keybindings, (result) => view.close(result, "done"))),
			)
				.then((component) => {
					if (!this.views.has(id)) {
						component.dispose?.();
						return;
					}
					view.component = component;
					if (isFocusable(component)) component.focused = true;
					this.render(view);
				})
				.catch((error: unknown) => {
					this.views.delete(id);
					signal?.removeEventListener("abort", onAbort);
					this.output({ type: "view_closed", id, reason: "aborted" });
					reject(error);
				});
		});
	}

	/**
	 * `ctx.ui.setWidget` with a component factory once the client shows views: its lines go out as an
	 * ordinary widget. Returns false when the client does not show views (the factory is then ignored).
	 */
	setWidget(key: string, factory: WidgetFactory, send: (lines: string[]) => void): boolean {
		this.removeWidget(key);
		if (!this.keybindings) return false;
		const component = factory(this.tui, theme);
		const lines = component.render(this.terminal.columns);
		this.widgets.set(key, { component, lines, send });
		send(lines);
		return true;
	}

	removeWidget(key: string): void {
		this.widgets.get(key)?.component.dispose?.();
		this.widgets.delete(key);
	}

	/**
	 * fork: the session these views belong to is being replaced. Each open view ends as
	 * cancelled, so the old extension's wait ends and a later view_input for its id is refused; widgets are released.
	 */
	closeAll(): void {
		for (const view of [...this.views.values()]) view.close(undefined, "aborted");
		for (const key of [...this.widgets.keys()]) this.removeWidget(key);
	}

	/** The client's height in rows (the terminal's height, for views that size themselves from it). */
	get rows(): number {
		return this.terminal.rows;
	}

	/** The fork's view commands; `undefined` for any other command. */
	handleCommand(command: { id?: string; type: string; [key: string]: unknown }): object | undefined {
		const respond = (success: boolean, data?: object, error?: string) => ({
			id: command.id,
			type: "response",
			command: command.type,
			success,
			...(data ? { data } : {}),
			...(error ? { error } : {}),
		});
		const view = typeof command.viewId === "string" ? this.views.get(command.viewId) : undefined;
		switch (command.type) {
			case "set_views": {
				const { columns, rows } = command;
				if (typeof columns !== "number" || typeof rows !== "number")
					return respond(false, undefined, "columns and rows are required");
				return respond(
					true,
					this.configure(
						columns,
						rows,
						typeof command.theme === "string" ? command.theme : undefined,
						command.nativeMenus === true,
					),
				);
			}
			case "view_input":
				if (!view || typeof command.data !== "string") return respond(false, undefined, "No such view");
				view.component?.handleInput?.(command.data);
				this.render(view);
				return respond(true);
			case "view_action":
				if (!view?.component?.handleNativeMenuInput?.(command.action))
					return respond(false, undefined, "Invalid menu action or expired view");
				return respond(true);
			case "view_mouse": {
				const event = command.event as Pick<TuiMouseEvent, "type" | "button" | "x" | "y"> & Partial<TuiMouseEvent>;
				if (!view || typeof event?.x !== "number" || typeof event.y !== "number")
					return respond(false, undefined, "No such view");
				view.component?.handleMouse?.({
					shift: false,
					alt: false,
					ctrl: false,
					...event,
					screenX: event.x,
					screenY: event.y,
					width: view.columns,
					height: view.lines.length,
				});
				this.render(view);
				return respond(true);
			}
			case "view_close":
				// Closed by the client (Escape outside the view, conversation closed): the caller gets
				// `undefined`, as when a terminal view is cancelled.
				if (!view) return respond(false, undefined, "No such view");
				view.close(undefined, "client");
				return respond(true);
		}
		return undefined;
	}

	private configure(
		columns: number,
		rows: number,
		themeName: string | undefined,
		nativeMenus: boolean,
	): { theme: string | undefined; error?: string } {
		this.terminal.columns = Math.max(20, Math.floor(columns));
		this.terminal.rows = Math.max(5, Math.floor(rows));
		if (!this.keybindings) {
			this.keybindings = KeybindingsManager.create();
			setKeybindings(this.keybindings);
			// What the client draws: 24-bit colour, no inline images, links as "text (url)".
			setCapabilityOverrides({ trueColor: true, images: null, hyperlinks: false });
		}
		setViewsClient(nativeMenus);
		const result = themeName ? setTheme(themeName) : { success: true };
		if (themeName) {
			for (const view of this.views.values()) view.component?.invalidate();
			for (const { component } of this.widgets.values()) component.invalidate();
		}
		this.renderAll();
		return { theme: theme.name, ...(result.success ? {} : { error: result.error }) };
	}

	private render(view: OpenView): void {
		if (!view.component || !this.views.has(view.id)) return;
		const { columns: width, rows: height } = this.terminal;
		const options = typeof view.overlay === "function" ? view.overlay() : view.overlay;
		let columns = width;
		if (options) {
			const wanted = size(options.width, width) ?? Math.min(80, width);
			columns = Math.min(width, Math.max(wanted, options.minWidth ?? 0));
		}
		let lines = view.component.render(Math.max(10, columns));
		const maxHeight = options ? size(options.maxHeight, height) : undefined;
		if (maxHeight !== undefined) lines = lines.slice(0, Math.max(1, maxHeight));
		const menu = view.component.nativeMenu ? JSON.stringify(view.component.nativeMenu) : undefined;
		if (
			columns === view.columns &&
			menu === view.menu &&
			lines.length === view.lines.length &&
			lines.every((line, i) => line === view.lines[i])
		)
			return;
		view.columns = columns;
		view.lines = lines;
		view.menu = menu;
		this.output({
			type: "view_frame",
			id: view.id,
			columns,
			lines,
			...(view.component.nativeMenu ? { menu: view.component.nativeMenu } : {}),
		});
	}

	private renderAll(): void {
		for (const view of this.views.values()) this.render(view);
		for (const widget of this.widgets.values()) {
			const lines = widget.component.render(this.terminal.columns);
			if (lines.length === widget.lines.length && lines.every((line, i) => line === widget.lines[i])) continue;
			widget.lines = lines;
			widget.send(lines);
		}
	}
}
