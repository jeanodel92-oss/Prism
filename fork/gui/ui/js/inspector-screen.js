// Native inspectors read the engine's reports. Large JSON sections are paged without discarding their content.
import { facts, Panel, Segmented } from "./components.js";
import { clear, copyText, h } from "./dom.js";
import { t } from "./i18n.js";
import { keepExport } from "../phone/transfer.js";

const COMMAND = { sent: "get_request_report", trace: "get_trace_report", state: "get_session_report", lsp: "get_lsp_report" };
const PAGE_SIZE = 32000;
const json = (value) => JSON.stringify(value, null, 2) ?? "";

function reader(text) {
	let offset = 0;
	let found = -1;
	const body = h("pre", { class: "ctx-text inspector-text" });
	const position = h("span", { class: "muted", role: "status" });
	const previous = h("button", { type: "button", text: t("key.pageup"), onclick: () => { offset = Math.max(0, offset - PAGE_SIZE); draw(); } });
	const next = h("button", { type: "button", text: t("key.pagedown"), onclick: () => { offset += PAGE_SIZE; draw(); } });
	const search = h("input", { type: "search", class: "field", placeholder: t("ctxSearch"), "aria-label": t("ctxSearch") });
	const draw = () => {
		body.textContent = text.slice(offset, offset + PAGE_SIZE);
		if (found >= offset && found < offset + PAGE_SIZE && search.value) {
			const mark = h("mark", { text: text.slice(found, Math.min(found + search.value.length, offset + PAGE_SIZE)) });
			body.replaceChildren(document.createTextNode(text.slice(offset, found)), mark, document.createTextNode(text.slice(found + mark.textContent.length, offset + PAGE_SIZE)));
			mark.scrollIntoView({ block: "nearest" });
		}
		previous.disabled = offset === 0;
		next.disabled = offset + PAGE_SIZE >= text.length;
		position.textContent = `${Math.min(offset + 1, text.length)}–${Math.min(text.length, offset + PAGE_SIZE)} / ${text.length}`;
	};
	const find = (from = 0) => {
		const lower = text.toLowerCase();
		const query = search.value.toLowerCase();
		found = query ? lower.indexOf(query, from) : -1;
		if (found < 0 && from > 0) found = lower.indexOf(query);
		offset = found < 0 ? 0 : Math.floor(found / PAGE_SIZE) * PAGE_SIZE;
		draw();
		if (query && found < 0) position.textContent = t("noMatches");
	};
	search.addEventListener("input", () => find());
	search.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		find(found + 1);
	});
	draw();
	return h("div", {}, h("div", { class: "inspector-pages" }, search, h("button", { type: "button", text: t("inspector.findNext"), onclick: () => find(found + 1) })), h("div", { class: "inspector-pages" }, previous, position, next), body);
}

/** What a session was doing when it stopped (the engine's session state): /state's report and the card on resume. */
export function sessionStateBody(data) {
	return [
		facts([[t("inspector.lastTurn"), t(`inspector.${data.status}`)], [t("inspector.interruptedCalls"), data.calls.length], [t("bgTitle"), data.running ?? t("inspector.off")], [t("inspector.checkpoints"), data.checkpoints.join(", ") || t("permNoRules")]]),
		data.calls.length > 0 && h("p", { class: "panel-text", text: t("inspector.recover") }),
		...data.calls.map((call) => h("div", { class: "check" }, h("strong", { text: call.name }), h("pre", { class: "ctx-text", text: call.args }))),
	].filter(Boolean);
}

export async function inspectorScreen(view, name) {
	const data = await view.engine.request({ type: COMMAND[name] });
	const panel = new Panel({ title: t(`inspector.${name}`), kind: `report inspector inspector-${name}` });
	const content = h("div");
	let selectedText = json(data);
	const copy = h("button", { type: "button", text: t("copy"), onclick: async () => { if (await copyText(selectedText)) view.app.toast(t("entryCopied")); } });
	panel.setActions(copy);

	if (name === "sent") {
		if (data.message) panel.setBody(h("p", { class: "panel-text", text: data.message }));
		else {
			const sections = ["preparedPrompt", "providerPayload", "sessionEntries"];
			const show = (key) => {
				selectedText = json(data[key]);
				clear(content);
				content.append(reader(selectedText));
			};
			const tabs = new Segmented({ label: t("inspector.sent"), value: sections[0], options: sections.map((value) => ({ value, label: t(`inspector.${value}`) })), onChange: show });
			panel.setBody(facts([["ID", data.correlationId], [t("inspector.provider"), data.provider], [t("inspector.endpoint"), data.endpoint], [t("model"), data.model], [t("status"), t(`inspector.${data.response}`)]]), tabs.el, content, h("p", { class: "panel-text muted", text: data.limitations }));
			show(sections[0]);
			const exportButton = h("button", { type: "button", text: t("exportReport"), onclick: () => {
				const path = h("input", { class: "field", value: "prism-request.json", "aria-label": t("exportPath") });
				const write = h("button", { type: "submit", text: t("write") });
				const form = h("form", { class: "inspector-export", onsubmit: async (event) => {
					event.preventDefault();
					write.disabled = true;
					try {
						const result = await view.engine.request({ type: "request_export", path: path.value });
						view.app.toast(t("doctorExported", result.path), "info", { sticky: true });
						panel.setActions(copy, exportButton);
						await keepExport(view, result.path);
					} catch (error) { view.app.toast(error.message, "error"); }
					finally { write.disabled = false; }
				} }, path, write);
				panel.setActions(copy, form);
				path.focus();
				path.select();
			} });
			panel.setActions(copy, exportButton);
		}
	} else if (name === "state") {
		panel.setBody(...sessionStateBody(data));
	} else {
		const entries = name === "trace" ? data.records : data.servers;
		const search = h("input", { class: "field", type: "search", placeholder: t("ctxSearch"), "aria-label": t("ctxSearch"), dataset: { autofocus: "" } });
		const list = h("div", { class: "checks" });
		let page = 0;
		let pageCount = 1;
		const more = h("button", { type: "button", text: t("key.pagedown"), onclick: () => { page = (page + 1) % pageCount; draw(); } });
		const draw = () => {
			const query = search.value.toLocaleLowerCase();
			const shown = entries.filter((entry) => json(entry).toLocaleLowerCase().includes(query));
			clear(list);
			for (const entry of shown.slice(page * 100, (page + 1) * 100)) {
				const detail = h("details", { class: "check", dataset: { state: entry.state } }, h("summary", {}, h("span", { class: "check-name", text: entry.toolName ?? entry.name }), h("span", { class: "check-observed", text: entry.label ?? t(`inspector.${entry.state}`) }), entry.timestamp && h("span", { class: "muted", text: entry.timestamp })));
				detail.addEventListener("toggle", () => { if (detail.open && detail.childElementCount === 1) detail.append(reader(json(entry))); });
				list.append(detail);
			}
			if (!shown.length) list.append(h("p", { class: "panel-text muted", text: t("noMatch") }));
			more.hidden = shown.length <= 100;
			pageCount = Math.max(1, Math.ceil(shown.length / 100));
			more.textContent = `${t("key.pagedown")} (${page + 1} / ${pageCount})`;
		};
		search.addEventListener("input", () => { page = 0; draw(); });
		draw();
		panel.setBody(
			name === "trace" && h("p", { class: "panel-text", text: !data.enabled ? t("inspector.traceOff") : data.failed ? t("inspector.traceFailed") : data.file }),
			data.notice && h("p", { class: "panel-text warning", text: data.notice }), search, list, more,
		);
	}
	await view.showPanel(name, panel);
}
