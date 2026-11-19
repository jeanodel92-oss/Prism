// The module supplies project detection, switches and install commands. Preparing one only edits the composer.
import { Panel } from "./components.js";
import { clear, h } from "./dom.js";
import { t } from "./i18n.js";

export async function lspSetupScreen(view, all = false) {
	let data = await view.engine.request({ type: "lsp_setup_get", all });
	const panel = new Panel({ title: data.heading, kind: "report lsp-setup" });
	const list = h("div", { class: "checks" });
	const query = h("input", { class: "field", type: "search", placeholder: t("ctxSearch"), "aria-label": t("ctxSearch"), dataset: { autofocus: "" } });
	const notice = h("p", { class: "panel-text muted", text: data.notice ?? "" });
	const showAll = h("button", { type: "button", text: t("lspSetupAll"), onclick: async () => {
		try { data = await view.engine.request({ type: "lsp_setup_get", all: true }); draw(); }
		catch (error) { view.app.toast(error.message, "error"); }
	} });
	const draw = () => {
		panel.setTitle(data.heading);
		showAll.hidden = data.all;
		clear(list);
		const wanted = query.value.toLowerCase();
		for (const server of data.servers.filter((entry) => `${entry.name} ${entry.language} ${entry.state}`.toLowerCase().includes(wanted))) {
			const enabled = h("input", { type: "checkbox", checked: server.enabled, disabled: !server.configured, "aria-label": t("lspSetupEnabled", server.name) });
			enabled.addEventListener("change", async () => {
				enabled.disabled = true;
				try { data = await view.engine.request({ type: "lsp_setup_set", name: server.name, enabled: enabled.checked, all: data.all }); }
				catch (error) { view.app.toast(error.message, "error"); }
				draw();
				list.querySelector(`[data-server='${server.name}'] input`)?.focus();
			});
			const prepare = server.configured && server.install && !server.sudo && server.command && h("button", { type: "button", text: t("lspSetupPrepare"), onclick: async () => {
				try {
					const { line } = await view.engine.request({ type: "lsp_setup_install", name: server.name });
					view.app.setComposerText(line);
					panel.done();
					view.app.toast(t("lspSetupPrepared"));
				} catch (error) { view.app.toast(error.message, "error"); }
			} });
			list.append(h("section", { class: "check", style: "padding: 12px", dataset: { server: server.name } },
				h("label", { class: "native-menu-field" }, h("span", { text: `${server.name} · ${server.language}` }), enabled),
				h("p", { class: "panel-text muted", text: server.state }),
				server.configured && server.install && h("p", { class: "panel-text", text: server.install }), prepare,
			));
		}
		if (!list.childElementCount) list.append(h("p", { class: "panel-text muted", text: t("noMatch") }));
	};
	query.addEventListener("input", draw);
	panel.setBody(notice, query, showAll, list);
	draw();
	await view.showPanel("lsp-setup", panel);
}
