// A user extension's terminal views (`ctx.ui.custom`): the shipped commands are native, a user's own view is still
// drawn as lines by the window (views.json).
import type { ExtensionAPI } from "../../../../../packages/coding-agent/src/core/extensions/types.ts";

function view(title: string, done: (value: undefined) => void, requestRender: () => void) {
	let page = 0;
	return {
		render: () => [title, page === 0 ? "First page" : "Second page", "esc: close"],
		handleInput(data: string) {
			if (data === "\x1b") done(undefined);
			else if (data === "\x1b[B") {
				page = 1;
				requestRender();
			}
		},
		invalidate() {},
	};
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("my-view", {
		description: "A personal inline view",
		handler: async (_args, ctx) => {
			await ctx.ui.custom<undefined>((tui, _theme, _keys, done) => view("My view", done, () => tui.requestRender()));
		},
	});
	pi.registerCommand("my-overlay", {
		description: "A personal overlay view",
		handler: async (_args, ctx) => {
			await ctx.ui.custom<undefined>(
				(tui, _theme, _keys, done) => view("My overlay", done, () => tui.requestRender()),
				{ overlay: true },
			);
		},
	});
}
