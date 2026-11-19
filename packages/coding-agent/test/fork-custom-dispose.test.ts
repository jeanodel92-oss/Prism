/**
 * fork: `ctx.ui.custom` with an async factory. When the signal was aborted,
 * or `done` called, before the factory returned its component, the component was never shown and never disposed: its
 * timers and subscriptions outlived the command.
 */
import { type Component, Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type Disposable = Component & { dispose?(): void };
type Factory = (
	tui: unknown,
	theme: unknown,
	keys: unknown,
	done: (value: string) => void,
) => Disposable | Promise<Disposable>;

function harness() {
	const ui = new TuiMainScreen(new VirtualTerminal(80, 24));
	const editor = new Container();
	const mode = {
		ui,
		editor: Object.assign(editor, { getText: () => "", setText: () => {} }),
		editorContainer: new Container(),
		extensionWindowsOpened: 0,
		keybindings: {},
		disposeActiveSelector: () => {},
	};
	const show = Reflect.get(InteractiveMode.prototype, "showExtensionCustom") as (
		this: typeof mode,
		factory: Factory,
		options?: { signal?: AbortSignal },
	) => Promise<string | undefined>;
	return (factory: Factory, options?: { signal?: AbortSignal }) => show.call(mode, factory, options);
}

function component(): Disposable & { disposed: number } {
	const made = {
		disposed: 0,
		render: () => ["panel"],
		invalidate() {},
		dispose() {
			made.disposed++;
		},
	};
	return made;
}

describe("fork: a custom component built after its window ended", () => {
	beforeAll(() => initTheme("dark"));

	it("disposes a component whose signal was aborted while the factory built it", async () => {
		const show = harness();
		const controller = new AbortController();
		const made = component();
		let build!: (value: Disposable) => void;
		const result = show(
			() =>
				new Promise<Disposable>((resolve) => {
					build = resolve;
				}),
			{ signal: controller.signal },
		);
		controller.abort();
		expect(await result).toBeUndefined();
		build(made);
		await new Promise((resolve) => setImmediate(resolve));
		expect(made.disposed).toBe(1);
	});

	it("disposes a component whose factory called done before returning it, once", async () => {
		const show = harness();
		const made = component();
		const result = show(async (_tui, _theme, _keys, done) => {
			done("early");
			return made;
		});
		expect(await result).toBe("early");
		await new Promise((resolve) => setImmediate(resolve));
		expect(made.disposed).toBe(1);
	});

	it("still disposes a shown component once when it closes", async () => {
		const show = harness();
		const made = component();
		let close!: (value: string) => void;
		const result = show((_tui, _theme, _keys, done) => {
			close = done;
			return made;
		});
		await new Promise((resolve) => setImmediate(resolve));
		close("done");
		expect(await result).toBe("done");
		expect(made.disposed).toBe(1);
	});

	it("ignores a factory that fails after the abort", async () => {
		const show = harness();
		const controller = new AbortController();
		let fail!: (error: Error) => void;
		const result = show(
			() =>
				new Promise<Disposable>((_resolve, reject) => {
					fail = reject;
				}),
			{
				signal: controller.signal,
			},
		);
		controller.abort();
		fail(new Error("too late"));
		expect(await result).toBeUndefined();
	});
});
