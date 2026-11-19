// `/mcp` as native screens in the Prism window. The manager keeps every operation,
// validation and connection; this shows its McpUi screens, one after another, in a single panel.
import type { ExtensionCommandContext } from "../core/extensions/types.ts";
import type { McpMenu, McpUi } from "../extensions/mcp/ui.ts";
import { t } from "./i18n/index.ts";
import { lines, NativeFlow, showNativeFlow } from "./native-flow.ts";

export class NativeMcpView extends NativeFlow implements McpUi {
	constructor(changed: () => void) {
		super(changed, { screenId: "loading", kind: "detail", title: t("MCP servers"), busy: true });
	}

	menu(build: () => McpMenu, subscribe?: (listener: () => void) => () => void): Promise<string | undefined> {
		const prefix = this.nextPrefix();
		return this.wait<string>((finish) => {
			let values = new Set<string>();
			const render = () => {
				const menu = build();
				values = new Set(menu.items.map((item) => item.value));
				// A menu whose confirm key goes back only lists things to read.
				const readOnly = menu.confirmLabel === menu.cancelLabel;
				this.show(
					{
						screenId: `menu:${menu.title}`,
						kind: menu.items.length === 0 ? "detail" : readOnly ? "browse" : "choice",
						title: menu.title,
						lines: lines(
							menu.details,
							menu.items.length === 0 ? (menu.empty ?? t("Nothing to show.")) : undefined,
						),
						errors: lines(menu.error),
						hint: menu.cancelLabel === "close" ? "close" : "back",
						items: menu.items.map((item) => ({
							id: prefix + item.value,
							label: item.label,
							...(readOnly ? { details: lines(item.description) } : { description: item.description }),
						})),
						...(menu.selected !== undefined ? { initialItemId: prefix + menu.selected } : {}),
					},
					(action) => {
						if (action.kind === "back") {
							finish(undefined);
							return true;
						}
						const id = typeof action.itemId === "string" ? action.itemId : "";
						const value = id.slice(prefix.length);
						if (action.kind !== "activate" || !id.startsWith(prefix) || !values.has(value)) return false;
						finish(value);
						return true;
					},
				);
			};
			render();
			return subscribe?.(render) ?? (() => {});
		});
	}

	status(title: string, message: string): void {
		if (this.closed) return;
		this.show({ screenId: "status", kind: "detail", title, lines: lines(message), busy: true });
	}

	redirectUrl(title: string, authorizationUrl: string, signal: AbortSignal): Promise<string | undefined> {
		return this.wait<string>((finish) => {
			const onAbort = () => finish(undefined);
			if (signal.aborted) {
				onAbort();
				return () => {};
			}
			signal.addEventListener("abort", onAbort, { once: true });
			this.show(
				{
					screenId: "redirect",
					kind: "input",
					title,
					lines: [t("Approve access in your browser. If it did not open, visit:")],
					link: authorizationUrl,
					notes: [t("If the browser runs on another machine, paste the URL it was redirected to:")],
				},
				(action) => {
					if (action.kind === "back") {
						finish(undefined);
						return true;
					}
					if (action.kind !== "input" || typeof action.value !== "string") return false;
					// As in the terminal, an empty submission keeps waiting.
					if (action.value.trim()) finish(action.value.trim());
					return true;
				},
			);
			return () => signal.removeEventListener("abort", onAbort);
		});
	}
}

/** `showMcpManager` for a client that draws native menus. */
export function showNativeMcpManager(
	ctx: ExtensionCommandContext,
	manage: (ui: McpUi) => Promise<void>,
): Promise<void> {
	return showNativeFlow<NativeMcpView>(ctx, (changed) => new NativeMcpView(changed), manage);
}
