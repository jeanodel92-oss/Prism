// /resume and /sessions in the window (native screens). The saved sessions of this folder or of all of them, a search (of the names at once, of the text of the sessions just after), and
// each session's actions on its own line: the mouse going to a button cannot change which session it acts on. The engine
// lists, renames and deletes (rpc-builtins.ts, sessions_*), as the terminal's selector does.

import { Panel, Segmented } from "./components.js";
import { clear, h } from "./dom.js";
import { t } from "./i18n.js";

const SHOWN = 200;

// `/sessions [all] <keywords>`: the screen opens on that search.
export async function sessionsScreen(view, args = "") {
	const panel = new Panel({ title: t("sessionsTitle"), kind: "report sessions" });
	const listEl = h("ul", { class: "sessions-list" });
	const everywhere = /^all(\s|$)/.test(args);
	let scope = everywhere ? "all" : "here";
	let sessions = [];
	const excerpts = new Map(); // path → what matched the search in the session's text
	let searching;
	let current = null;
	let renaming; // the path being renamed
	let deleting; // the path asked to be deleted

	const openPaths = () => new Set([current, ...view.app.sessions.map((session) => session.path)].filter(Boolean));
	const title = (session) => session.name || session.firstMessage || t("untitled");

	// fork: only the latest list and search apply. Switched quickly between here and
	// all, an earlier answer that arrived last showed the other scope's sessions.
	let listed = 0;
	let searched = 0;
	const load = async () => {
		const request = ++listed;
		const answer = await view.engine.request({ type: "sessions_list", all: scope === "all" });
		if (request !== listed) return;
		sessions = answer.sessions;
		current = answer.current;
		draw();
	};
	const act = async (command, done) => {
		try {
			const answer = await view.engine.request(command);
			if (answer.error) view.app.toast(answer.error, "warning");
			else done?.(answer);
		} catch (error) {
			view.app.toast(String(error?.message ?? error), "error");
		}
		renaming = undefined;
		deleting = undefined;
		await load();
		view.app.refreshHistory();
	};

	const findInText = async () => {
		const request = ++searched;
		const query = search.value.trim();
		const hits = query ? (await view.engine.request({ type: "sessions_search", query, all: scope === "all" })).hits : [];
		if (request !== searched || search.value.trim() !== query) return;
		excerpts.clear();
		for (const hit of hits) if (!excerpts.has(hit.path)) excerpts.set(hit.path, hit.text);
		draw();
	};

	const search = h("input", {
		class: "field",
		type: "search",
		spellcheck: "false",
		placeholder: t("sessionsFilter"),
		"aria-label": t("sessionsFilter"),
		value: everywhere ? args.slice(3).trim() : args,
		dataset: { autofocus: "" },
		oninput: () => {
			draw();
			clearTimeout(searching);
			searching = setTimeout(findInText, 250);
		},
	});

	const row = (session, open) => {
		if (renaming === session.path) {
			const input = h("input", { class: "field", type: "text", value: session.name ?? "", "aria-label": t("sessionsRename"), dataset: { rename: "" } });
			return h(
				"li",
				{ class: "sessions-row" },
				h(
					"form",
					{
						class: "sessions-form",
						onsubmit: (event) => {
							event.preventDefault();
							act({ type: "sessions_rename", path: session.path, name: input.value });
						},
					},
					input,
					h("button", { type: "submit", text: t("sessionsSave") }),
					h("button", {
						type: "button",
						class: "ghost",
						text: t("sessionsCancel"),
						onclick: () => {
							renaming = undefined;
							draw();
						},
					}),
				),
			);
		}
		const when = new Date(session.modified).toLocaleString(document.documentElement.lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
		return h(
			"li",
			{ class: "sessions-row", dataset: { open: String(open) } },
			h(
				"button",
				{ type: "button", class: "sessions-open", title: session.path, onclick: () => panel.done(session.path) },
				h("span", { class: "sessions-name", text: title(session) }),
				excerpts.has(session.path) && h("span", { class: "sessions-excerpt", text: excerpts.get(session.path) }),
				h("span", { class: "sessions-meta", text: [when, t("sessionsMessages", session.messageCount), open && t("sessionsOpenHere"), scope === "all" && session.cwd].filter(Boolean).join(" · ") }),
			),
			h("button", {
				type: "button",
				class: "ghost",
				dataset: { action: "rename" },
				text: t("sessionsRename"),
				onclick: () => {
					renaming = session.path;
					deleting = undefined;
					draw();
					listEl.querySelector("[data-rename]")?.focus();
				},
			}),
			deleting === session.path
				? [
						h("button", {
							type: "button",
							class: "danger",
							dataset: { action: "delete-sure" },
							text: t("sessionsDeleteSure"),
							onclick: () =>
								act({ type: "sessions_delete", path: session.path }, (answer) =>
									view.app.toast(t(answer.method === "trash" ? "sessionsTrash" : "sessionsGone")),
								),
						}),
						h("button", {
							type: "button",
							class: "ghost",
							text: t("sessionsCancel"),
							onclick: () => {
								deleting = undefined;
								draw();
							},
						}),
					]
				: !open &&
						h("button", {
							type: "button",
							class: "ghost",
							dataset: { action: "delete" },
							text: t("sessionsDelete"),
							onclick: () => {
								deleting = session.path;
								renaming = undefined;
								draw();
							},
						}),
		);
	};

	const draw = () => {
		const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
		const found = sessions.filter((session) => {
			const text = `${session.name ?? ""} ${session.firstMessage ?? ""} ${session.cwd ?? ""}`.toLowerCase();
			return excerpts.has(session.path) || words.every((word) => text.includes(word));
		});
		const open = openPaths();
		const scroll = listEl.scrollTop;
		clear(listEl);
		if (found.length === 0) listEl.append(h("li", { class: "panel-text muted", text: t("sessionsNone") }));
		listEl.append(...found.slice(0, SHOWN).map((session) => row(session, open.has(session.path))));
		if (found.length > SHOWN) listEl.append(h("li", { class: "panel-text muted", text: t("sessionsMore", found.length - SHOWN) }));
		listEl.scrollTop = scroll;
	};

	const tabs = new Segmented({
		label: t("sessionsTitle"),
		value: scope,
		options: [
			{ value: "here", label: t("sessionsHere") },
			{ value: "all", label: t("sessionsAll") },
		],
		onChange: (value) => {
			scope = value;
			renaming = undefined;
			deleting = undefined;
			listEl.scrollTop = 0;
			Promise.all([load(), findInText()]).catch((error) => view.app.toast(String(error?.message ?? error), "error"));
		},
	});
	panel.setBody(tabs.el, search, listEl);
	await Promise.all([load(), findInText()]);
	const path = await view.showPanel("resume", panel);
	view.app.refreshHistory();
	if (path) await view.app.openSession(path, undefined, sessions.find((session) => session.path === path)?.cwd);
}
