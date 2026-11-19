// Prism's graphical adapter. The upstream runtime still owns navigation, actions, signals and errors.
import { randomUUID } from "node:crypto";
import * as kit from "../../node_modules/@narumitw/pi-tui-kit/dist/index.js";
export * from "../../node_modules/@narumitw/pi-tui-kit/dist/index.js";

const menuOwners = new WeakMap();
const OWNER = Symbol("nativeMenuOwner");

export async function runMenu(ctx, definition, options) {
    if (ctx.mode !== "rpc" || !ctx.hasUI || !globalThis[Symbol.for("prism.hasNativeMenus")]?.()) {
        return kit.runMenu(ctx, definition, options);
    }
    // A plug-in can open another runMenu from an action; X must not reopen its waiting parent.
    const owner = ctx[OWNER] ?? ctx;
    let group = menuOwners.get(owner);
    if (!group) {
        group = { id: randomUUID(), controller: new AbortController(), depth: 0 };
        menuOwners.set(owner, group);
    }
    group.depth++;
    const controller = group.controller;
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let screen;
    let screenId;
    let setting;
    const show = async () => {
        const result = await ctx.ui.custom((_tui, _theme, _keys, done) => ({
            nativeMenu: { ...screen, screenId, menuId: group.id },
            render: () => [],
            invalidate() {},
            handleNativeMenuInput(input) {
                if (!input || typeof input !== "object") return false;
                if (input.kind === "back") { done(input); return true; }
                if (screen.kind === "input" && input.kind === "input" && typeof input.value === "string") {
                    done(input); return true;
                }
                if (screen.kind === "review" && screen.confirm && input.kind === "activate" && input.itemId === screen.confirm.id) {
                    done(input); return true;
                }
                const items = [...(screen.items ?? []), ...(screen.actions ?? [])];
                const item = items.find((candidate) => candidate.id === input.itemId);
                if (!item || item.disabled) return false;
                if (screen.kind === "settings") {
                    if (input.kind !== "setting" || !(item.values ?? [item.currentValue]).includes(input.value)) return false;
                } else if (screen.kind === "multiSelect" && screen.items.includes(item)) {
                    if (input.kind !== "multiSelect" || typeof input.selected !== "boolean" || input.selected === item.selected) return false;
                } else if (input.kind !== "activate" || !["actions", "choice", "multiSelect"].includes(screen.kind)) return false;
                done(input);
                return true;
            },
        }), { overlay: true, signal, nativeMenu: true });
        // Closing the panel closes the whole menu; the explicit Back action keeps its navigation stack.
        if (!result && !signal.aborted) controller.abort();
        return result;
    };
    const adapted = {
        ...ctx,
        [OWNER]: owner,
        ui: {
            ...ctx.ui,
            async input() { return (await show())?.value; },
            async select(_title, choices) {
                const result = await show();
                if (!result || result.kind === "back") {
                    return screen.kind === "actions" ? undefined : choices.at(-1);
                }
                if (screen.kind === "review") return choices.at(-2);
                const index = [...(screen.items ?? []), ...(screen.actions ?? [])].findIndex((item) => item.id === result.itemId);
                if (screen.kind === "settings") setting = result;
                return choices[index];
            },
        },
    };
    const native = {
        ...definition,
        screens: Object.fromEntries(Object.entries(definition.screens).map(([id, factory]) => [id, (context) => {
            screenId = id;
            screen = factory(context);
            return screen;
        }])),
        actions: Object.fromEntries(Object.entries(definition.actions).map(([id, handler]) => [id, (context) => {
            const chosen = setting;
            setting = undefined;
            return handler({ ...context, ctx, ...(chosen?.itemId === context.itemId ? { value: chosen.value } : {}) });
        }])),
    };
    try {
        const result = await kit.runMenu(adapted, native, {
            ...options, signal,
            getState: (context) => options.getState({ ...context, ctx }),
            onError: options.onError ? (_context, error) => options.onError(ctx, error) : undefined,
        });
        return controller.signal.aborted ? { kind: "closed", reason: "close" } : result;
    } finally {
        if (--group.depth === 0) {
            menuOwners.delete(owner);
            controller.abort();
        }
    }
}
