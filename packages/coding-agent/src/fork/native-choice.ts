// Structured choices for fork screens; the command keeps its operations and owns the selected identifiers.
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "../core/extensions/types.ts";
import { hasNativeMenus } from "./interactive-client.ts";

interface Choice {
	id: string;
	label: string;
	description?: string;
	statusText?: string;
	searchText?: string;
}

export function nativeChoices(ctx: ExtensionContext) {
	if (!hasNativeMenus(ctx)) return undefined;
	const menuId = randomUUID();
	let closed = false;
	return async (screen: {
		screenId: string;
		title: string;
		lines?: string[];
		doneLabel?: string;
		items: Choice[];
		kind?: "choice" | "actions";
	}) => {
		if (closed) return undefined;
		const options = { overlay: true, nativeMenu: true };
		const result = await ctx.ui.custom<{ id?: string } | undefined>(
			(_tui, _theme, _keys, done) => ({
				nativeMenu: { kind: "choice", ...screen, menuId },
				render: () => [],
				invalidate() {},
				handleNativeMenuInput(input: unknown) {
					if (!input || typeof input !== "object") return false;
					const action = input as Record<string, unknown>;
					if (action.kind === "back") {
						done({});
						return true;
					}
					const item = screen.items.find((item) => item.id === action.itemId);
					if (action.kind !== "activate" || !item) return false;
					done({ id: item.id });
					return true;
				},
			}),
			options,
		);
		// X closes the whole command, while the explicit Back action keeps its parent navigation.
		if (!result) closed = true;
		return result?.id;
	};
}
