// /files in the window ("it is a GUI, not a terminal: make a real file explorer"). Two places, the
// project's folders and the files Prism produced in this conversation; a path bar, a filter, a list with sizes and
// dates, a preview of the chosen file, and its actions (add to the message, copy the path, open with the system's
// application, copy to a folder). The engine reads the disk and refuses what is not the project's or produced
// (rpc-builtins.ts, files_*); several files can be added at once.

import { Panel, Segmented } from "./components.js";
import { ansiLine } from "./ansi.js";
import { clear, copyText, h } from "./dom.js";
import { formatNumber, t } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";
import { shellQuote } from "./shell-quote.js";
import { downloadFromPc } from "../phone/transfer.js";

const size = (bytes) =>
	bytes === undefined ? "" : bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const when = (ms) => (ms ? new Date(ms).toLocaleString(document.documentElement.lang, { dateStyle: "short", timeStyle: "short" }) : "");

/** A reference to a file in a message, as the terminal's browser writes it (`@path`, quoted with spaces). */
function reference(path) {
	return `@${/\s/.test(path) ? `"${path}"` : path}`;
}

function fileIcon(row) {
	const kind = row.dir ? "folder" : /\.(?:ts|tsx|js|jsx|py|rs|c|cpp|h|go|sh|json|css|html|yaml|yml|toml)$/i.test(row.name) ? "code" : /\.(?:png|jpe?g|gif|webp|svg|avif)$/i.test(row.name) ? "image" : "file";
	const paths = {
		folder: "M3 6h6l2 2h10v12H3Z M3 6V4h6l2 2h10v2",
		file: "M6 2h8l4 4v16H6Z M14 2v5h4 M9 12h6 M9 16h6",
		code: "M6 2h8l4 4v16H6Z M14 2v5h4 M10 11l-3 3 3 3 M14 11l3 3-3 3",
		image: "M3 3h18v18H3Z M3 17l6-6 4 4 3-3 5 5 M16 7h.01",
	};
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	for (const [name, value] of Object.entries({ class: "files-icon", viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", "data-kind": kind })) svg.setAttribute(name, value);
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", paths[kind]);
	svg.append(path);
	return svg;
}

export async function filesScreen(view, place = "project") {
	const panel = new Panel({ title: t("filesTitle"), kind: "report files" });
	let tab = place;
	let dir = "";
	let listing = { entries: [], more: 0, dir: "" };
	let produced = [];
	let chosen; // { path (relative or absolute), name, dir? }
	const marked = new Set(); // paths ticked to add together
	const filter = h("input", { class: "field", type: "search", placeholder: t("filesFilter"), "aria-label": t("filesFilter"), dataset: { autofocus: "" } });
	const crumbs = h("nav", { class: "files-crumbs", "aria-label": t("filesWhere") });
	const list = h("ul", { class: "files-list", role: "listbox", "aria-multiselectable": "true", "aria-label": t("filesTitle") });
	const preview = h("div", { class: "files-preview", "aria-live": "polite" });

	const request = (command) =>
		view.engine.request(command).catch((error) => {
			view.app.toast(String(error?.message ?? error), "error");
			return undefined;
		});

	const load = async () => {
		if (tab === "project") listing = (await request({ type: "files_list", dir })) ?? listing;
		else produced = (await request({ type: "files_produced" }))?.files ?? produced;
		draw();
	};

	const rows = () => {
		const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
		const keep = (name) => words.every((word) => name.toLowerCase().includes(word));
		if (tab === "project")
			return listing.entries.filter((entry) => keep(entry.name)).map((entry) => ({ ...entry, path: listing.dir ? `${listing.dir}/${entry.name}` : entry.name }));
		return [...produced].reverse().filter((file) => keep(file.relative ?? file.path)).map((file) => ({ name: file.relative ?? file.path, path: file.relative ?? file.path, dir: false, size: file.size, mtimeMs: file.at, state: file.state, source: file.source }));
	};

	const drawCrumbs = () => {
		clear(crumbs);
		if (tab !== "project") return;
		const parts = listing.dir ? listing.dir.split("/") : [];
		const go = (target) => h("button", { type: "button", class: "ghost crumb", onclick: () => open(target) });
		const root = go("");
		root.textContent = t("filesRoot");
		crumbs.append(root);
		parts.forEach((part, i) => {
			const crumb = go(parts.slice(0, i + 1).join("/"));
			crumb.textContent = part;
			crumbs.append(h("span", { class: "sep", text: "/" }), crumb);
		});
	};

	const draw = () => {
		drawCrumbs();
		clear(list);
		const shown = rows();
		if (tab === "project" && listing.dir)
			list.append(h("li", { class: "files-up", role: "option", tabindex: "0", onclick: () => open(listing.dir.split("/").slice(0, -1).join("/")), onkeydown: enter(() => open(listing.dir.split("/").slice(0, -1).join("/"))) }, h("span", { class: "files-icon", text: "↰" }), h("span", { class: "files-name", text: t("filesUp") })));
		if (shown.length === 0) list.append(h("li", { class: "files-empty muted", text: tab === "project" ? t("filesEmpty") : t("filesNoneProduced") }));
		for (const row of shown) {
			const tick =
				!row.dir &&
				h("input", {
					type: "checkbox",
					class: "files-tick",
					"aria-label": t("filesTick", row.name),
					checked: marked.has(row.path),
					onclick: (event) => event.stopPropagation(),
					onchange: (event) => {
						if (event.target.checked) marked.add(row.path);
						else marked.delete(row.path);
						drawActions();
					},
				});
			list.append(
				h(
					"li",
					{
						role: "option",
						tabindex: "0",
						"aria-selected": String(chosen?.path === row.path),
						dataset: { dir: String(row.dir), state: row.state ?? "" },
						title: row.path,
						onclick: () => (row.dir ? open(row.path) : choose(row)),
						ondblclick: () => !row.dir && attach([row.path]),
						onkeydown: enter(() => (row.dir ? open(row.path) : choose(row))),
					},
					tick || h("span", { class: "files-tick-space" }),
					fileIcon(row),
					h("span", { class: "files-name", text: row.name }),
					h("span", { class: "files-meta muted", text: row.dir ? "" : [row.source && t(`produced.${row.source}`), row.state === "absent" ? t("filesGone") : row.state === "changed" ? t("filesChanged") : "", size(row.size)].filter(Boolean).join(" · ") }),
					h("span", { class: "files-date muted", text: when(row.mtimeMs) }),
				),
			);
		}
		if (tab === "project" && listing.more) list.append(h("li", { class: "files-empty muted", text: t("filesMore", formatNumber(listing.more)) }));
		drawActions();
	};

	const enter = (work) => (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		work();
	};

	const open = async (target) => {
		dir = target;
		chosen = undefined;
		filter.value = "";
		clear(preview);
		await load();
		list.querySelector("li[role='option']")?.focus();
	};

	const choose = async (row) => {
		chosen = row;
		for (const item of list.querySelectorAll("li[role='option']")) item.setAttribute("aria-selected", String(item.title === row.path));
		drawActions();
		clear(preview);
		preview.append(h("p", { class: "panel-text muted", text: t("filesLoading") }));
		const answer = await request({ type: "files_preview", path: row.path });
		if (chosen !== row) return;
		clear(preview);
		const shown = answer?.preview;
		if (!shown) return;
		preview.append(h("div", { class: "files-preview-head" }, h("strong", { text: row.name }), h("span", { class: "muted", text: [shown.type, size(shown.size)].filter(Boolean).join(" · ") })));
		if (shown.problem || shown.note) preview.append(h("p", { class: "panel-text muted", text: shown.problem ?? shown.note }));
		if (shown.image) preview.append(h("img", { class: "files-image", alt: row.name, src: `data:${shown.image.mimeType};base64,${shown.image.data}` }));
		else if (shown.kind === "markdown" && shown.text) preview.append(h("div", { class: "markdown files-text" }, renderMarkdown(shown.text)));
		else if (answer.highlighted) preview.append(h("pre", { class: "files-text files-code" }, ansiLine(answer.highlighted.join("\n"))));
		else if (shown.text !== undefined) preview.append(h("pre", { class: "files-text", text: shown.text }));
		// One column (a narrow window, the phone): the preview is under the whole list, out of sight; bring it up.
		if (getComputedStyle(preview.parentElement).gridTemplateColumns.split(" ").length === 1) preview.scrollIntoView({ block: "start" });
	};

	const attach = (paths) => {
		if (paths.length === 0) return;
		const current = view.app.composerText();
		const glue = current === "" || /\s$/.test(current) ? "" : " ";
		// In a ! command a path is a shell word: `@report;make` would end the command at `;`.
		const words = current.trimStart().startsWith("!") ? paths.map(shellQuote) : paths.map(reference);
		view.app.setComposerText(`${current}${glue}${words.join(" ")} `);
		view.app.toast(t("filesAdded", paths.length));
		panel.done?.();
	};

	// Where to copy the chosen file: a field under the preview (the window has no system prompt dialog).
	const askFolder = (path) => {
		preview.querySelector(".files-export")?.remove();
		const field = h("input", { class: "field", type: "text", placeholder: t("filesExportWhere"), "aria-label": t("filesExportWhere"), spellcheck: "false" });
		const form = h(
			"form",
			{
				class: "files-export",
				onsubmit: async (event) => {
					event.preventDefault();
					const answer = await request({ type: "files_export", path, folder: field.value });
					if (answer?.error) view.app.toast(answer.error, "warning");
					else if (answer?.copy) {
						view.app.toast(t("filesExported", answer.copy));
						form.remove();
					}
				},
			},
			field,
			h("button", { type: "submit", text: t("filesExportGo") }),
		);
		preview.prepend(form);
		field.focus();
	};

	const remote = Boolean(view.app.info?.remote);
	// The file travels over the link (phone/transfer.js); the engine decides whether this screen may reach it.
	const toPhone = async (path, open) => {
		try {
			const name = await downloadFromPc({ request: (command) => view.engine.request(command), path, open });
			if (!open) view.app.toast(t("downloadSaved", name));
		} catch (error) {
			view.app.toast(String(error?.message ?? error), "warning");
		}
	};

	const drawActions = () => {
		const many = [...marked];
		const one = chosen && !chosen.dir ? chosen.path : undefined;
		panel.setActions(
			many.length > 0 && h("button", { type: "button", class: "primary", text: t("filesAddMany", many.length), onclick: () => attach(many) }),
			many.length === 0 && one && h("button", { type: "button", class: "primary", text: t("filesAdd"), onclick: () => attach([one]) }),
			one &&
				h("button", {
					type: "button",
					text: t("filesCopyPath"),
					onclick: async () => {
						if (await copyText(one)) view.app.toast(t("filesCopied"));
					},
				}),
			// On the phone, "Open" and "Export" would act on the PC, where nobody looks: the file comes to the phone instead.
			one &&
				h("button", {
					type: "button",
					text: remote ? t("filesOpenPhone") : t("filesOpen"),
					onclick: remote
						? () => toPhone(one, true)
						: async () => {
								const answer = await request({ type: "files_open", path: one });
								if (answer?.error) view.app.toast(answer.error, "warning");
								else if (answer) view.app.toast(t("filesOpened"));
							},
				}),
			one &&
				h("button", {
					type: "button",
					text: remote ? t("filesSavePhone") : t("filesExport"),
					onclick: remote ? () => toPhone(one, false) : () => askFolder(one),
				}),
		);
	};

	const places = new Segmented({
		label: t("filesTitle"),
		value: tab,
		options: [
			{ value: "project", label: t("filesProject") },
			{ value: "produced", label: t("filesProduced") },
		],
		onChange: async (value) => {
			tab = value;
			chosen = undefined;
			clear(preview);
			await load();
		},
	});
	filter.addEventListener("input", draw);
	filter.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowDown") return;
		event.preventDefault();
		list.querySelector("li[role='option']")?.focus();
	});
	list.addEventListener("keydown", (event) => {
		const items = [...list.querySelectorAll("li[role='option']")];
		const at = items.indexOf(document.activeElement);
		const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
		if (step && at >= 0) {
			event.preventDefault();
			(items[at + step] ?? (step < 0 ? filter : items[at]))?.focus();
		} else if (event.key === "Backspace" && tab === "project" && listing.dir) {
			event.preventDefault();
			open(listing.dir.split("/").slice(0, -1).join("/"));
		} else if (event.key === " " && at >= 0) {
			const tick = items[at].querySelector(".files-tick");
			if (tick) {
				event.preventDefault();
				tick.click();
			}
		}
	});

	panel.setBody(places.el, h("div", { class: "files-bar" }, crumbs, filter), h("div", { class: "files-layout" }, list, preview));
	await load();
	await view.showPanel("files", panel);
}
