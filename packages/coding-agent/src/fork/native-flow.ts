// a command's screens, one after another, in a single native panel of the Prism window.
// The command keeps every operation and validation; a flow only shows its screens and returns the answers.
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "../core/extensions/types.ts";

export type NativeScreen = { screenId: string; kind: string; title: string; [key: string]: unknown };
export type NativeAction = Record<string, unknown>;

/** Splits texts into display lines, dropping absent ones. */
export const lines = (...texts: (string | undefined)[]) => texts.flatMap((text) => (text ? text.split("\n") : []));

export class NativeFlow {
	private readonly menuId = randomUUID();
	private readonly changed: () => void;
	private screen: NativeScreen & { menuId: string };
	private handler: ((action: NativeAction) => boolean) | undefined;
	/** Resolves the screen waiting for an answer with `undefined`. */
	private cancel: (() => void) | undefined;
	private serial = 0;
	/**
	 * fork: the number of the question on screen, sent with each screen and sent back
	 * with each action. An answer queued for an earlier question (a double submit) is refused by the next one; the
	 * redraws of one question keep its number, so a box checked just before its Save still counts.
	 */
	private revision = 0;
	private waiting = false;
	protected closed = false;

	constructor(changed: () => void, loading: NativeScreen) {
		this.changed = changed;
		this.screen = { ...loading, menuId: this.menuId };
	}

	get nativeMenu(): NativeScreen {
		return this.screen;
	}

	handleNativeMenuInput(input: unknown): boolean {
		if (!input || typeof input !== "object") return false;
		const revision = (input as NativeAction).revision;
		if (revision !== undefined && revision !== this.revision) return false;
		return this.handler?.(input as NativeAction) ?? false;
	}

	/** The panel was closed: every later screen resolves at once, so no parent screen comes back. */
	close(): void {
		this.closed = true;
		this.cancel?.();
	}

	/** Identifiers carry their screen's number: a click sent before the screen changed is refused. */
	protected nextPrefix(): string {
		return `${++this.serial}:`;
	}

	/** The item id of an action on a screen whose ids carry `prefix`; undefined for another screen's item. */
	protected itemOf(action: NativeAction, prefix: string): string | undefined {
		const id = action.itemId;
		return typeof id === "string" && id.startsWith(prefix) ? id.slice(prefix.length) : undefined;
	}

	protected show(screen: NativeScreen, handler?: (action: NativeAction) => boolean): void {
		// A screen shown between two questions (a sign-in's dialog, a busy screen) is a new one too; its redraws are not.
		if (!this.waiting && screen.screenId !== this.screen.screenId) this.revision++;
		this.screen = { ...screen, revision: this.revision, menuId: this.menuId };
		this.handler = handler;
		this.changed();
	}

	protected wait<T>(open: (finish: (value: T | undefined) => void) => () => void): Promise<T | undefined> {
		if (this.closed) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			let cleanup: (() => void) | undefined;
			let settled = false;
			const finish = (value: T | undefined) => {
				if (settled) return;
				settled = true;
				this.waiting = false;
				if (this.cancel === cancel) this.cancel = undefined;
				this.handler = undefined;
				cleanup?.();
				resolve(value);
			};
			const cancel = () => finish(undefined);
			this.cancel = cancel;
			this.revision++;
			this.waiting = true;
			cleanup = open(finish);
			if (settled) cleanup();
		});
	}
}

/** Runs a command's flow in one native panel, as `ctx.ui.custom` runs its terminal view. */
export async function showNativeFlow<F extends NativeFlow>(
	ctx: ExtensionContext,
	create: (changed: () => void) => F,
	run: (flow: F) => Promise<void>,
): Promise<void> {
	const options = { overlay: true, nativeMenu: true };
	await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
		const flow = create(() => tui?.requestRender());
		void run(flow).then(
			() => done(),
			(error: unknown) => {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				done();
			},
		);
		return {
			get nativeMenu() {
				return flow.nativeMenu;
			},
			handleNativeMenuInput: (input: unknown) => flow.handleNativeMenuInput(input),
			render: () => [],
			invalidate() {},
			dispose: () => flow.close(),
		};
	}, options);
}
