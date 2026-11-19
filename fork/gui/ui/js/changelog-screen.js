// /changelog in the window ("/changelog still looks like the terminal"). The versions on the left, the
// chosen one's notes on the right, and a search over all of them. The engine gives the notes (rpc-builtins.ts, get_changelog).

import { ListBox, Panel } from "./components.js";
import { clear, h } from "./dom.js";
import { t } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";

export async function changelogScreen(view) {
	const { versions } = await view.engine.request({ type: "get_changelog" });
	const panel = new Panel({ title: t("changelogTitle"), kind: "report changelog" });
	if (versions.length === 0) {
		panel.setBody(h("p", { class: "panel-text muted", text: t("changelogNone") }));
		await view.showPanel("changelog", panel);
		return;
	}
	const notes = h("div", { class: "changelog-notes markdown", tabindex: "0" });
	const show = (version) => {
		clear(notes);
		notes.append(h("h3", { text: version.title }), renderMarkdown(version.markdown));
		notes.scrollTop = 0;
	};
	const lower = versions.map((version) => `${version.title}\n${version.markdown}`.toLowerCase());
	const items = versions.map((version, index) => ({ label: version.title, value: index }));
	const list = new ListBox({
		items,
		empty: t("changelogNoMatch"),
		onChoose: (item) => show(versions[item.value]),
	});
	const search = h("input", {
		class: "field",
		type: "search",
		placeholder: t("changelogSearch"),
		"aria-label": t("changelogSearch"),
		spellcheck: "false",
		oninput: () => {
			const wanted = search.value.trim().toLowerCase();
			const found = items.filter((item) => !wanted || lower[item.value].includes(wanted));
			list.setItems(found);
			if (found.length > 0) show(versions[found[0].value]);
		},
	});
	panel.setBody(h("div", { class: "changelog-layout" }, h("div", { class: "changelog-side" }, search, list.el), notes));
	show(versions[0]);
	await view.showPanel("changelog", panel);
}
