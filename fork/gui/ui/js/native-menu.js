// Screen definitions come from pi-tui-kit. The engine owns every action and validates each submitted value.
import { fuzzyFilter } from "../vendor/fuzzy.js";
import { ListBox } from "./components.js";
import { h } from "./dom.js";
import { t } from "./i18n.js";
import { boundAction } from "./keys.js";
import { renderMarkdown } from "./markdown.js";

// One action at a time per view. A click while the previous one is on its way (a box just checked, then
// Continue) is sent after it rather than dropped: the engine checks it against the screen it shows by then,
// and one meant for a screen that has gone is refused without a message, as a click on a closed panel.
export async function send(view, action, queued = false) {
	if (view.nativeSending) {
		(view.nativeQueue ??= []).push(action);
		return;
	}
	view.nativeSending = true;
	// Marked busy while on its way, without disabling anything: a click meanwhile is queued.
	view.el.querySelector(".native-menu")?.setAttribute("aria-busy", "true");
	// The panel keeps the keyboard: the next screen replaces the focused control, and takes the focus back.
	view.refocus = true;
	try {
		await view.session.engine.request({ type: "view_action", viewId: view.id, action });
	} catch (error) {
		if (!queued) view.session.toast(error.message, "error");
	} finally {
		view.nativeSending = false;
		view.refocus = false;
		const root = view.el.querySelector(".native-menu");
		if (root && root.dataset.busy !== "true") root.removeAttribute("aria-busy");
		const lost = !document.activeElement || document.activeElement === document.body;
		if (lost && root && !view.closed) {
			const controls = [...root.querySelectorAll("button, input, select, textarea")].filter((el) => !el.disabled);
			const focus = view.session.menuStates?.get(`${view.owner}/${root.dataset.screen}`)?.focus;
			(controls.find((el) => el.dataset.item === focus) ?? controls[0])?.focus({ preventScroll: true });
		}
		const next = view.nativeQueue?.shift();
		if (next && !view.closed) void send(view, next, true);
	}
}

export function nativeMenu(view, screen) {
	const root = h("div", { class: "native-menu", dataset: { kind: screen.kind, screen: screen.screenId } });
	const owner = `${view.owner}/${screen.menuId}`;
	if (view.session.menuStateOwner !== owner) {
		view.session.menuStateOwner = owner;
		view.session.menuStates = new Map();
	}
	const key = `${view.owner}/${screen.screenId}`;
	const states = (view.session.menuStates ??= new Map());
	const state = states.get(key) ?? {};
	states.set(key, state);
	const submit = (action) => {
		if (view.closed || screen.busy) return;
		if (action.itemId) state.focus = action.itemId;
		// fork: the question it answers; queued, it is refused by the next question.
		send(view, screen.revision === undefined ? action : { ...action, revision: screen.revision });
	};
	const back = () => submit({ kind: "back" });
	root.addEventListener("keydown", (event) => {
		// A screen with nothing behind it in a dialog (Settings): Escape is the dialog's own.
		if (screen.busy || screen.root || boundAction(view.session.keys, ["app.interrupt"], event)?.id !== "app.interrupt") return;
		event.preventDefault();
		event.stopPropagation();
		back();
	});
	const document = (content, format) => format?.kind === "markdown"
		? h("div", { class: "markdown" }, renderMarkdown(content, view.session.app.markdownOptions))
		: h("pre", { class: "native-menu-document", text: content });
	const button = (item) => h("button", {
		type: "button", class: "native-menu-action", disabled: item.disabled, title: item.disabledReason,
		dataset: { item: item.id }, onclick: () => submit({ kind: "activate", itemId: item.id }),
	}, h("span", { text: item.label }), item.description ? h("small", { text: item.description }) : undefined);
	// A page to open, then the lines that refer to it: `link` (one URL) or `links` ({url, label?}).
	const linksAndNotes = () => {
		const links = [...(screen.link ? [{ url: screen.link }] : []), ...(screen.links ?? [])];
		for (const link of links) {
			const text = link.label ? `${link.label}: <${link.url}>` : `<${link.url}>`;
			root.append(h("div", { class: "markdown native-menu-link" }, renderMarkdown(text, view.session.app.markdownOptions)));
		}
		for (const line of screen.notes ?? []) root.append(h("p", { class: "panel-text", text: line }));
	};
	view.panel.setTitle(screen.title);
	for (const line of screen.lines ?? []) root.append(h("p", { class: "panel-text", text: line }));
	// /login's warnings about a Claude account, in bold red (error) or yellow (warning).
	for (const alert of screen.alerts ?? []) root.append(h("p", { class: `panel-text alert ${alert.tone === "error" ? "error" : "warning"}`, text: alert.text }));
	for (const line of screen.errors ?? []) root.append(h("p", { class: "panel-text error", text: line }));
	// An operation is running: the engine answers with the next screen, there is nothing to go back to.
	if (screen.busy) root.dataset.busy = "true";
	if (screen.busy || view.nativeSending) root.setAttribute("aria-busy", "true");
	if (screen.kind === "settings" || screen.kind === "multiSelect") {
		const rows = [];
		if (screen.enableSearch) {
			const filter = h("input", { class: "field", type: "search", placeholder: t("filter"), "aria-label": t("filter"), value: state.query ?? "" });
			const search = () => {
				state.query = filter.value;
				const shown = new Set(fuzzyFilter(rows, filter.value, ({ item }) => `${item.label} ${item.description ?? ""} ${item.searchText ?? ""}`));
				for (const row of rows) row.el.hidden = !shown.has(row);
			};
			filter.addEventListener("input", search);
			root.append(filter);
			queueMicrotask(search);
		}
		for (const item of screen.items) {
			const field = screen.kind === "settings"
				? item.values
					? h("select", { disabled: item.disabled, "aria-label": item.label, title: item.currentValue, dataset: { item: item.id } }, ...item.values.map((value) => h("option", { value, text: value, selected: value === item.currentValue })))
					: h("button", { type: "button", disabled: item.disabled, "aria-label": item.label, text: item.currentValue, dataset: { item: item.id }, onclick: () => submit({ kind: "setting", itemId: item.id, value: item.currentValue }) })
				: h("input", { type: "checkbox", disabled: item.disabled, checked: item.selected, "aria-label": item.label, dataset: { item: item.id } });
			field.addEventListener("change", () => submit(screen.kind === "settings"
				? { kind: "setting", itemId: item.id, value: field.value }
				: { kind: "multiSelect", itemId: item.id, selected: field.checked }));
			const row = h(field.tagName === "BUTTON" ? "div" : "label", { class: "native-menu-field", title: item.disabledReason }, h("span", {}, item.group ? h("small", { class: "native-menu-group", text: item.group }) : undefined, h("span", { text: item.label }), item.stateTag ? h("span", { class: "native-menu-state", text: item.stateTag }) : undefined, item.description ? h("small", { text: item.description }) : undefined), field);
			root.append(row);
			rows.push({ item, el: row });
		}
		for (const item of screen.actions ?? []) root.append(button(item));
	} else if (screen.kind === "input") {
		linksAndNotes();
		// A secret (an API key) is masked and never kept by the browser's autofill.
		// A multi-line text (a plan to paste) takes Enter as a new line: the button, or Ctrl+Enter, applies it.
		const input = screen.multiline
			? h("textarea", { class: "field", rows: "8", placeholder: screen.placeholder ?? "", "aria-label": screen.title, dataset: { autofocus: "" } })
			: h("input", { class: "field", type: screen.secret ? "password" : "text", autocomplete: screen.secret ? "off" : undefined, placeholder: screen.placeholder ?? "", value: screen.value ?? "", "aria-label": screen.title, dataset: { autofocus: "" } });
		if (screen.multiline) {
			input.value = screen.value ?? "";
			input.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
				event.preventDefault();
				submit({ kind: "input", value: input.value });
			});
		}
		root.append(h("form", { class: `native-menu-input${screen.multiline ? " multiline" : ""}`, onsubmit: (event) => { event.preventDefault(); submit({ kind: "input", value: input.value }); } }, input, h("button", { type: "submit", class: "primary", text: t("nativeApply") })));
		for (const item of screen.actions ?? []) root.append(button(item));
	} else if (screen.kind === "review") {
		root.append(document(screen.content, screen.format));
		if (screen.confirm) root.append(button(screen.confirm));
		for (const item of screen.actions ?? []) root.append(button(item));
	} else if (screen.kind === "detail") {
		// The detail's full body is already in its lines above, with the pages to open (a sign-in's) and what follows
		// them; an operation may add how far it got.
		linksAndNotes();
		if (typeof screen.progress === "number") root.append(h("progress", { class: "native-menu-progress", max: 1, value: screen.progress }));
	} else if (screen.kind === "browse" || screen.kind === "choice") {
		const detail = h("div", { class: "native-menu-detail" });
		// The item last selected in this screen survives its live updates (/mcp while servers connect).
		const kept = screen.items.findIndex((item) => item.id === state.selected);
		const list = new ListBox({
			filter: "fuzzy", placeholder: t("filter"), empty: t("noMatch"),
			selected: kept >= 0 ? kept : Math.max(0, screen.items.findIndex((item) => item.id === (screen.initialItemId ?? screen.currentItemId))),
			onSelect: (item) => { if (item) state.selected = item.value.id; },
			items: screen.items.map((item) => ({ label: item.label, description: [item.description, ...(item.details ?? [])].filter(Boolean).join(" · "), searchText: item.searchText, value: item, disabled: item.disabled, title: item.disabledReason, current: item.id === screen.currentItemId, meta: item.statusText })),
			onChoose: ({ value: item }) => {
				if (screen.kind === "choice") submit({ kind: "activate", itemId: item.id });
				else detail.replaceChildren(h("h3", { text: item.label }), document(item.detailDocument?.content ?? (item.details ?? []).join("\n"), item.detailDocument?.format));
			},
		});
		// `query`: the filter the command was given (/login <name>), until the reader types another.
		list.field.value = state.query ?? screen.query ?? "";
		list.field.addEventListener("input", () => { state.query = list.field.value; });
		// Filtering selects the first match: only a kept filter is applied, so the initial item stays selected.
		if (list.field.value) list.field.dispatchEvent(new Event("input"));
		root.append(list.el, detail);
	} else {
		for (const item of screen.items ?? []) root.append(button(item));
	}
	if (!screen.busy && !screen.root) root.append(h("button", { type: "button", class: "ghost native-menu-back", text: screen.doneLabel ?? t(screen.hint === "close" || screen.hint === "stop" ? screen.hint : "nativeBack"), onclick: back }));
	const focus = [...root.querySelectorAll("[data-item]")].find((el) => el.dataset.item === state.focus && !el.disabled)
		?? root.querySelector("[data-autofocus], input:not(:disabled), select:not(:disabled), button:not(:disabled)");
	if (focus) focus.dataset.autofocus = "";
	return root;
}
