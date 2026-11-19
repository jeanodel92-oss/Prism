// The window's own screens for terminal screens that are data, not text: /tree and /doctor. The engine gives
// the data and runs the operations (rpc-inspect.ts); these panels only show them with the window's components,
// where the terminal draws a column of box characters.

import { facts, ListBox, Panel, Segmented } from "./components.js";
import { clear, copyText, h } from "./dom.js";
import { formatNumber, t } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";
import { keepExport } from "../phone/transfer.js";

// ------------------------------------------------------------------------------------------------- /doctor

const STATUSES = ["problem", "not tested", "ok"];

/** /doctor: the checks as a list to filter by state, each one opening on its cause and what to do. */
export async function doctorScreen(view) {
	const report = await view.engine.request({ type: "get_doctor" });
	const count = (status) => report.checks.filter((check) => check.status === status).length;
	let filter = count("problem") ? "problem" : "all";
	const panel = new Panel({ title: t("doctorTitle"), kind: "report doctor" });
	const list = h("div", { class: "checks" });
	const draw = () => {
		clear(list);
		const shown = report.checks.filter((check) => filter === "all" || check.status === filter);
		if (shown.length === 0) list.append(h("p", { class: "panel-text muted", text: t("doctorNone") }));
		for (const check of shown)
			list.append(
				h(
					"details",
					{ class: "check", dataset: { status: check.status } },
					h(
						"summary",
						{},
						h("span", { class: "check-state", role: "img", "aria-label": t(`status.${check.status}`), title: t(`status.${check.status}`) }),
						h("span", { class: "check-name", text: check.component }),
						h("span", { class: "check-observed", text: check.observed }),
					),
					facts([
						[t("causeLabel"), check.cause],
						[t("actionLabel"), check.action],
						check.detail && check.detail !== check.observed && [t("detailLabel"), check.detail],
					]),
				),
			);
	};
	const tabs = new Segmented({
		label: t("doctorTitle"),
		value: filter,
		onChange: (value) => {
			filter = value;
			draw();
		},
		options: [
			{ value: "all", label: t("doctorAll", report.checks.length) },
			{ value: "problem", label: t("doctorProblems", count("problem")) },
			{ value: "not tested", label: t("doctorUntested", count("not tested")) },
			{ value: "ok", label: t("doctorOk", count("ok")) },
		],
	});
	draw();
	panel.setBody(tabs.el, list);

	// /doctor export PATH: the same masked report, written where the user says.
	const exportButton = h("button", { type: "button", text: t("exportReport"), onclick: () => askPath() });
	const askPath = () => {
		const field = h("input", { class: "field", type: "text", spellcheck: "false", value: "prism-doctor.json", "aria-label": t("exportPath"), title: t("exportPath") });
		const write = async () => {
			const path = field.value.trim();
			if (!path) return;
			try {
				const result = await view.engine.request({ type: "doctor_export", path });
				view.app.toast(t("doctorExported", result.path), "info", { sticky: true });
				panel.setActions(exportButton);
				await keepExport(view, result.path);
			} catch (error) {
				view.app.toast(error.message, "error");
			}
		};
		field.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			write();
		});
		panel.setActions(field, h("button", { type: "button", class: "primary", text: t("write"), onclick: write }));
		field.focus();
		field.select();
	};
	panel.setActions(exportButton);
	await view.showPanel("doctor", panel);
}

// --------------------------------------------------------------------------------------------------- /tree

const MODES = ["default", "no-tools", "user-only", "labeled-only", "all"];

/** The terminal's tree filters (tree-selector.ts): which entries each one shows. */
function shows(node, mode) {
	switch (mode) {
		case "user-only":
			return node.role === "user";
		case "no-tools":
			return !node.setting && node.role !== "toolResult";
		case "labeled-only":
			return Boolean(node.label);
		case "all":
			return true;
		default:
			return !node.setting;
	}
}

const MARKDOWN = new Set(["assistant", "compaction", "branch_summary", "custom"]);

const kindOf = (node) => (node.kind === "message" ? node.role : node.kind);

// A row is one line: Markdown's heading, emphasis and code marks would only be noise in it.
const plain = (text) => text.replace(/(^|\s)#{1,6}\s+/g, "$1").replace(/\*\*|__|`/g, "");

/**
 * /tree: the conversation's entries with their branches, filtered and searched as in the terminal. A click
 * shows an entry beside its actions (continue from it, label it, copy it); Enter or a double click continues
 * from it, as Enter does in the terminal. Continuing asks about the summary of the branch left, in the same
 * panel, and the conversation reloads at the chosen point.
 */
export async function treeScreen(view) {
	let data = await view.engine.request({ type: "get_tree" });
	if (data.nodes.length === 0) {
		view.app.toast(t("treeEmpty"));
		return;
	}
	let mode = MODES.includes(data.filterMode) ? data.filterMode : "default";
	let chosen = data.nodes.find((node) => node.id === data.leafId) ?? data.nodes.at(-1);
	const panel = new Panel({ title: t("treeTitle"), kind: "tree" });
	const time = (stamp) => new Date(stamp).toLocaleTimeString(document.documentElement.lang, { hour: "2-digit", minute: "2-digit" });
	const byId = new Map();
	let point;
	// An entry the filter hides stands for itself on its nearest shown ancestor: the current point (often a turn's
	// figures, which are bookkeeping) and the branches that start at a hidden entry.
	const shownAt = (id, ids) => {
		let node = byId.get(id);
		while (node && !ids.has(node.id)) node = byId.get(node.parentId);
		return node?.id;
	};
	const items = () => {
		byId.clear();
		for (const node of data.nodes) byId.set(node.id, node);
		const shown = data.nodes.filter((node) => !node.hidden && shows(node, mode));
		const ids = new Set(shown.map((node) => node.id));
		point = shownAt(data.leafId, ids);
		const forks = new Map();
		for (const node of data.nodes)
			if (node.branches > 1) {
				const at = shownAt(node.id, ids);
				if (at) forks.set(at, Math.max(forks.get(at) ?? 0, node.branches));
			}
		return shown.map((node) => ({
				value: node,
				label: plain(node.text) || t(`kind.${kindOf(node)}`),
				meta: [
					node.label && `#${node.label}`,
					node.id === point && t("currentPoint"),
					forks.has(node.id) && t("branches", forks.get(node.id)),
					t(`kind.${kindOf(node)}`),
					time(node.timestamp),
				]
					.filter(Boolean)
					.join(" · "),
				indent: node.depth,
				current: node.id === point,
				className: ["tree-row", `kind-${kindOf(node)}`, node.onPath && "on-path"].filter(Boolean).join(" "),
			}));
	};
	// The row of `node`, or of its nearest shown ancestor; the current point otherwise.
	const indexOf = (list, node) => {
		for (let at = node; at; at = byId.get(at.parentId)) {
			const index = list.findIndex((item) => item.value.id === at.id);
			if (index >= 0) return index;
		}
		return Math.max(0, list.findIndex((item) => item.current));
	};
	const list = new ListBox({ filter: true, placeholder: t("treeSearch"), empty: t("noMatch"), onChoose: (item, _index, via) => (via === "key" ? go(item.value) : show(item.value)) });
	list.list.addEventListener("dblclick", () => go(chosen));
	const tabs = new Segmented({
		label: t("treeTitle"),
		value: mode,
		options: MODES.map((value) => ({ value, label: t(`tree.${value}`) })),
		onChange: (value) => {
			mode = value;
			const next = items();
			list.setItems(next, indexOf(next, chosen));
		},
	});
	const detail = h("div", { class: "tree-detail" });

	const refresh = async () => {
		data = await view.engine.request({ type: "get_tree" });
		const next = items();
		list.setItems(next, indexOf(next, chosen));
		chosen = data.nodes.find((node) => node.id === chosen?.id) ?? chosen;
	};

	// The chosen entry: its whole text, from the engine (what the terminal's copy key copies), and its actions.
	let shownId;
	const show = async (node) => {
		chosen = node;
		shownId = node.id;
		const { text } = await view.engine.request({ type: "get_tree_entry", entryId: node.id });
		if (shownId !== node.id) return;
		clear(detail);
		detail.append(
			h("div", { class: "tree-detail-head" }, h("span", { text: t(`kind.${kindOf(node)}`) }), node.label && h("span", { class: "tag", text: `#${node.label}` })),
			// What the transcript draws as Markdown (answers, summaries) is drawn so here too; the rest as typed.
			text && MARKDOWN.has(kindOf(node))
				? h("div", { class: "tree-detail-text md" }, renderMarkdown(text, view.app.markdownOptions))
				: h("p", { class: "panel-text tree-detail-text", text: text ?? (node.text || t("noEntryText")) }),
		);
		panel.setActions(
			h("button", { type: "button", class: "primary", text: t("goHere"), disabled: node.id === point, onclick: () => go(node) }),
			h("button", { type: "button", text: t("labelEntry"), onclick: () => label(node) }),
			text &&
				h("button", {
					type: "button",
					text: t("copy"),
					onclick: async () => {
						if (await copyText(text)) view.app.toast(t("entryCopied"));
					},
				}),
		);
	};

	const label = (node) => {
		const field = h("input", { class: "field", type: "text", value: node.label ?? "", placeholder: t("labelPlaceholder"), "aria-label": t("labelPlaceholder") });
		field.addEventListener("keydown", async (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				show(node);
				return;
			}
			if (event.key !== "Enter") return;
			event.preventDefault();
			await view.engine.request({ type: "tree_label", entryId: node.id, label: field.value });
			await refresh();
			show(chosen);
		});
		panel.setActions(field);
		field.focus();
	};

	// Continuing from an entry: the summary question first (unless the settings skip it), then the engine moves
	// the conversation; a summary under way can be stopped, which comes back to the tree as in the terminal.
	const go = async (node) => {
		let summarize = false;
		let instructions;
		if (data.askSummary) {
			const answer = await askSummary();
			if (!answer) return draw();
			({ summarize, instructions } = answer);
		}
		const close = panel.onCancel;
		if (summarize) {
			const stop = () => view.engine.request({ type: "tree_abort" });
			panel.onCancel = stop;
			panel.setBody(h("p", { class: "panel-text", role: "status", text: t("summarizing") }));
			panel.setActions(h("button", { type: "button", text: t("cancel"), onclick: stop }));
		}
		const result = await view.engine.request({ type: "tree_navigate", entryId: node.id, summarize, instructions }).finally(() => {
			panel.onCancel = close;
		});
		if (result.message) view.app.toast(result.message);
		if (!result.navigated) {
			await refresh();
			return draw();
		}
		panel.done(true);
		await view.reload();
		if (result.editorText && !view.app.composerText().trim()) view.app.setComposerText(result.editorText);
	};

	const askSummary = () =>
		new Promise((done) => {
			// Escape here goes back to the tree, as in the terminal, not out of the panel.
			const close = panel.onCancel;
			const resolve = (answer) => {
				panel.onCancel = close;
				done(answer);
			};
			panel.onCancel = () => resolve(undefined);
			const options = [
				{ label: t("noSummary"), value: "none" },
				{ label: t("summarize"), value: "summary" },
				{ label: t("summarizeWith"), value: "instructions" },
			];
			const back = () => resolve(undefined);
			const choices = new ListBox({
				items: options,
				onChoose: (item) => {
					if (item.value !== "instructions") return resolve({ summarize: item.value === "summary" });
					const field = h("textarea", { class: "field", rows: "3", placeholder: t("summaryInstructions"), "aria-label": t("summaryInstructions") });
					field.addEventListener("keydown", (event) => {
						if (event.key !== "Enter" || event.shiftKey) return;
						event.preventDefault();
						resolve({ summarize: true, instructions: field.value });
					});
					panel.setBody(h("p", { class: "panel-text", text: t("summaryQuestion") }), field);
					panel.setActions(
						h("button", { type: "button", class: "primary", text: t("summarize"), onclick: () => resolve({ summarize: true, instructions: field.value }) }),
						h("button", { type: "button", text: t("cancel"), onclick: back }),
					);
					field.focus();
				},
			});
			panel.setBody(h("p", { class: "panel-text", text: t("summaryQuestion") }), choices.el);
			panel.setActions(h("button", { type: "button", text: t("cancel"), onclick: back }));
			choices.list.focus();
		});

	const draw = () => {
		panel.setBody(tabs.el, list.el, detail);
		show(chosen);
		panel.focus();
	};
	const first = items();
	list.setItems(first, indexOf(first, chosen));
	chosen = first[list.selected]?.value ?? chosen;
	draw();
	await view.showPanel("tree", panel);
}

// ------------------------------------------------------------------------------------------ /model-settings

/**
 * /model-settings: the current model's properties in a table, what the server reports beside what Prism sends,
 * each Prism value edited in place (a switch, a number, a text) and saved as the terminal saves it; a
 * correction can be removed. The engine parses and writes (rpc-inspect.ts), as the terminal's prompts do.
 */
export async function modelSettingsScreen(view) {
	const panel = new Panel({ kind: "report model-settings" });
	const body = h("table", { class: "settings-table" });
	const intro = h("p", { class: "panel-text muted" });
	let data;

	const save = async (row, value, field) => {
		try {
			const result = await view.engine.request({ type: "model_setting_set", key: row.key, ...(value === undefined ? {} : { value }) });
			if (result.warning) view.app.toast(result.warning, "warning");
			else view.app.toast(t("settingSaved", row.label));
			draw(result);
			view.refreshState?.();
		} catch (error) {
			if (field) {
				field.setAttribute("aria-invalid", "true");
				field.title = error.message;
			}
			view.app.toast(error.message, "warning");
		}
	};

	const editor = (row) => {
		if (row.type === "bool") {
			const choice = new Segmented({
				label: row.label,
				value: row.on ? "yes" : "no",
				options: [
					{ value: "yes", label: t("yes") },
					{ value: "no", label: t("no") },
				],
				onChange: (value) => save(row, value),
			});
			return choice.el;
		}
		const field = h("input", {
			class: "field",
			type: "text",
			spellcheck: "false",
			value: row.unset ? "" : row.prism,
			placeholder: row.prism,
			inputmode: row.type === "number" ? "decimal" : undefined,
			"aria-label": row.label,
		});
		const initial = field.value;
		const commit = () => {
			if (field.value.trim() === initial.trim()) return;
			// An emptied field removes the correction, as an empty answer does in the terminal.
			save(row, field.value.trim() === "" ? undefined : field.value, field);
		};
		field.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				commit();
			} else if (event.key === "Escape" && field.value !== initial) {
				event.preventDefault();
				event.stopPropagation();
				field.value = initial;
				field.removeAttribute("aria-invalid");
			}
		});
		field.addEventListener("change", commit);
		return field;
	};

	const draw = (next) => {
		data = next;
		panel.setTitle(data.model.name, `${data.model.provider}/${data.model.id}`);
		intro.textContent = data.intro;
		clear(body);
		// Without a server to read (a cloud provider), its column would only hold dashes: the intro says so.
		const server = Boolean(data.serverKind);
		body.append(
			h(
				"thead",
				{},
				h("tr", {}, h("th", { text: t("colProperty") }), server && h("th", { text: data.serverKind }), h("th", { text: "Prism" }), h("th")),
			),
			h(
				"tbody",
				{},
				data.rows.map((row) =>
					h(
						"tr",
						{ dataset: { key: row.key }, class: row.corrected ? "corrected" : undefined },
						h("th", { scope: "row", text: row.label }),
						server && h("td", { class: "server", text: row.server ?? "—", title: row.server === undefined ? t("notReported") : undefined }),
						h("td", { class: "prism" }, editor(row)),
						h(
							"td",
							{ class: "reset" },
							row.corrected &&
								h("button", {
									type: "button",
									class: "ghost small",
									text: t("resetCorrection"),
									title: t("resetHelp"),
									onclick: () => save(row, undefined),
								}),
						),
					),
				),
			),
		);
	};

	draw(await view.engine.request({ type: "get_model_settings" }));
	panel.setBody(intro, body);
	await view.showPanel("model-settings", panel);
}

// --------------------------------------------------------------------------------------------------- /context

// The parts of the context in a fixed order: each keeps its colour whatever the others weigh (style.css --series-N).
const PARTS = ["systemPrompt", "systemTools", "skills", "messages", "tools", "other"];
const ROLE_KIND = { toolResult: "tool", bashExecution: "bash", branchSummary: "branch_summary", compactionSummary: "compaction" };

/**
 * /context: where the context's tokens go (a bar of the window's size and its table), the system prompt, the
 * active tools' definitions and the messages the model gets, each in a tab with search and copy. The engine
 * gives the data and the estimate the terminal shows (rpc-inspect.ts, context-breakdown.ts).
 */
const COMPACTION_SETTINGS = Symbol("compaction settings");

export async function contextScreen(view) {
	const data = await view.engine.request({ type: "get_context" });
	// The session's system entry is the system prompt, which has its own tab.
	data.messages = data.messages.filter((message) => message.role !== "system");
	const parts = data.breakdown;
	const percent = (value, of) => {
		const share = (value / of) * 100;
		// A part too small to round to 0.1 % is not nothing.
		return share > 0 && share < 0.05 ? "< 0.1 %" : `${share.toLocaleString(document.documentElement.lang, { maximumFractionDigits: 1 })} %`;
	};
	const panel = new Panel({
		title: t("contextTitle"),
		subtitle: parts?.total ? t("ctxSummary", formatNumber(parts.total), formatNumber(parts.contextWindow), percent(parts.total, parts.contextWindow)) : "",
		kind: "report context",
	});
	const content = h("div", { class: "ctx-content" });
	const copyButton = (text) =>
		h("button", {
			type: "button",
			text: t("copy"),
			onclick: async () => {
				if (await copyText(text())) view.app.toast(t("entryCopied"));
			},
		});

	// the context gauge opens this screen, so it also says how compaction runs and
	// offers to compact, as the gauge's menu did.
	const compaction = () => data.compaction?.auto && h("p", { class: "panel-text ctx-compaction", text: data.compaction.auto });
	const command = (label, line) => h("button", { type: "button", text: label, onclick: () => panel.done(line) });
	const usage = () => {
		// Nothing measured before the first answer (the terminal shows an empty grid then).
		if (!parts?.total) return [h("p", { class: "panel-text muted", text: t("ctxNoUsage") }), compaction()];
		const window = parts.contextWindow;
		const rows = [
			...PARTS.map((part, i) => ({ part, value: parts[part], swatch: `series-${i + 1}` })),
			{ part: "free", value: parts.safeAvailable, swatch: "free" },
			{ part: "reserve", value: Math.min(parts.reserveTokens, window - parts.total), swatch: "reserve" },
		].filter((row) => row.value > 0);
		const label = (row) => `${t(`part.${row.part}`)} : ${formatNumber(row.value)} (${percent(row.value, window)})`;
		return [
			h(
				"div",
				{ class: "ctx-bar", role: "img", "aria-label": rows.map(label).join(" ; ") },
				rows.map((row) => h("span", { class: `ctx-part ${row.swatch}`, style: `flex-grow: ${((row.value / window) * 100).toFixed(3)}`, title: label(row) })),
			),
			h(
				"table",
				{ class: "ctx-table" },
				h("thead", {}, h("tr", {}, h("th", { text: "" }), h("th", { text: t("colPart") }), h("th", { text: "Tokens" }), h("th", { text: t("colShare") }))),
				h(
					"tbody",
					{},
					rows.map((row) =>
						h(
							"tr",
							{ dataset: { part: row.part } },
							h("td", {}, h("span", { class: `ctx-swatch ${row.swatch}` })),
							h("th", { scope: "row", text: t(`part.${row.part}`) }),
							h("td", { class: "num", text: formatNumber(row.value) }),
							h("td", { class: "num", text: percent(row.value, window) }),
						),
					),
				),
			),
			h("p", { class: "panel-text muted", text: `${t("ctxCompactAt", formatNumber(window - parts.reserveTokens))} ${t("ctxEstimate")}` }),
			compaction(),
		];
	};

	// A searchable list of entries that open on their content.
	const searchable = (entries, render) => {
		const list = h("div", { class: "checks ctx-list" });
		const field = h("input", { class: "field", type: "search", placeholder: t("ctxSearch"), "aria-label": t("ctxSearch"), dataset: { autofocus: "" } });
		const draw = () => {
			const words = field.value.toLowerCase().split(/\s+/).filter(Boolean);
			clear(list);
			const shown = entries.filter((entry) => words.every((word) => entry.search.includes(word)));
			if (shown.length === 0) list.append(h("p", { class: "panel-text muted", text: t("noMatch") }));
			for (const entry of shown) list.append(render(entry));
		};
		field.addEventListener("input", draw);
		draw();
		return [field, list];
	};

	const toolsText = () =>
		data.tools.map((tool) => [tool.name, tool.description, ...tool.parameters.map((p) => `  ${p.name} (${p.type}${p.required ? "" : `, ${t("optional")}`})${p.description ? `: ${p.description}` : ""}`)].filter(Boolean).join("\n")).join("\n\n");
	const roleName = (message) => t(`kind.${ROLE_KIND[message.role] ?? message.role}`);
	const messagesText = () => data.messages.map((m) => `## ${roleName(m)}${m.title ? ` · ${m.title}` : ""}\n\n${m.text}`).join("\n\n");

	const tabs = {
		usage: { label: t("ctxUsage"), body: usage, copy: undefined, actions: () => [command(t("compactNow"), "/compact"), h("button", { type: "button", text: t("compactionSettings"), onclick: () => panel.done(COMPACTION_SETTINGS) })] },
		system: { label: t("ctxSystem"), body: () => [h("pre", { class: "ctx-text", text: data.systemPrompt })], copy: () => data.systemPrompt },
		tools: {
			label: t("ctxTools", data.tools.length),
			copy: toolsText,
			body: () =>
				searchable(
					data.tools.map((tool) => ({ ...tool, search: `${tool.name} ${tool.description ?? ""}`.toLowerCase() })),
					(tool) =>
						h(
							"details",
							{ class: "check" },
							h("summary", {}, h("span", { class: "check-name", text: tool.name }), h("span", { class: "check-observed", text: tool.description?.split("\n")[0] ?? "" })),
							h("div", { class: "ctx-detail" }, tool.description && h("p", { class: "panel-text", text: tool.description }), tool.parameters.length > 0 && facts(tool.parameters.map((p) => [p.name, `${p.type}${p.required ? ` · ${t("required")}` : ` · ${t("optional")}`}${p.description ? ` — ${p.description}` : ""}`]))),
						),
				),
		},
		messages: {
			label: t("ctxMessages", data.messages.length),
			copy: messagesText,
			body: () =>
				searchable(
					data.messages.map((message) => ({ ...message, search: `${message.role} ${message.title ?? ""} ${message.text}`.toLowerCase() })),
					(message) =>
						h(
							"details",
							{ class: "check", dataset: { role: message.role } },
							h(
								"summary",
								{},
								h("span", { class: "check-name", text: roleName(message) }),
								h("span", { class: "check-observed", text: message.title || message.text.replace(/\s+/g, " ").slice(0, 160) }),
								h("span", { class: "ctx-tokens", text: t("approxTokens", formatNumber(message.tokens)) }),
							),
							h("pre", { class: "ctx-text", text: message.text || t("noEntryText") }),
						),
				),
		},
	};

	const show = (name) => {
		clear(content);
		content.append(...tabs[name].body().filter(Boolean));
		panel.setActions(tabs[name].actions?.() ?? (tabs[name].copy && copyButton(tabs[name].copy)));
		content.querySelector("[data-autofocus]")?.focus();
	};
	const choice = new Segmented({ label: t("contextTitle"), value: "usage", options: Object.entries(tabs).map(([value, tab]) => ({ value, label: tab.label })), onChange: show });
	panel.setBody(choice.el, content);
	show("usage");
	const line = await view.showPanel("context", panel);
	// the Settings at Conversation, where compaction's two settings come first.
	if (line === COMPACTION_SETTINGS) view.app.settingsDialog.open("conversation");
	else if (line) await view.prompt(line);
}
