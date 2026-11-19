// Agent files and invocation rules remain owned and validated by the engine.
import { ListBox, Panel } from "./components.js";
import { h } from "./dom.js";
import { t } from "./i18n.js";

export async function agentsScreen(view) {
	let data = await view.engine.request({ type: "agents_get" });
	const panel = new Panel({ title: t("agentsTitle"), kind: "report agents" });
	let query = "";
	const fail = (error) => view.app.toast(error.message, "error");
	const button = (action, text, onclick, primary = false) => h("button", { type: "button", class: primary ? "primary" : "", text, dataset: { action }, onclick });
	const row = (label, input) => h("label", { class: input.type === "checkbox" ? "native-menu-field" : "field-row" }, h("span", { text: label }), input);
	const list = () => {
		panel.setTitle(t("agentsTitle"));
		const choices = new ListBox({
			items: data.agents.map((agent) => ({ value: agent, label: agent.name, description: agent.description, meta: agent.model || t("agentsCurrentModel"), searchText: agent.tools.join(" ") })),
			filter: "fuzzy", placeholder: t("ctxSearch"), empty: t("agentsNone"), onChoose: ({ value }) => edit(value),
		});
		choices.field.value = query;
		choices.field.addEventListener("input", () => { query = choices.field.value; });
		choices.field.dispatchEvent(new Event("input"));
		// the agents running in the background, each with Stop.
		const running = (data.running ?? []).length ? h("section", { class: "agents-running" }, h("h3", { text: t("agentsRunning") }), data.running.map((run) => h("div", { class: "agents-run", dataset: { run: run.id } },
			h("span", { text: `${run.agent} (${run.id}) · ${run.step}` }),
			button("stop", t("agentsStop"), () => confirm(t("agentsStopTitle", run.agent), t("agentsStopDetail"), async () => { data = await view.engine.request({ type: "agents_stop", run: run.id }); list(); panel.focus(); })),
		))) : undefined;
		panel.setBody(data.help.map((text) => h("p", { class: "panel-text muted", text })), running, choices.el);
		panel.setActions(button("new", t("agentsNew"), () => edit()), button("policy", t("agentsPolicy"), policy), button("off", t("agentsOff"), () => confirm(t("agentsOff"), data.offDetail, async () => {
			await view.engine.request({ type: "agents_disable" });
			panel.done();
			const result = await view.engine.request({ type: "reload" });
			await view.refreshResources();
			if (result.error) view.app.toast(result.error, "warning");
			else view.app.toast(t("agentsDisabled"));
		} )));
	};
	const confirm = (title, text, apply, back = list) => {
		panel.setTitle(title);
		panel.setBody(h("p", { class: "panel-text", text }));
		const yes = button("confirm", t("confirm"), async () => { yes.disabled = true; try { await apply(); } catch (error) { fail(error); } finally { yes.disabled = false; } }, true);
		panel.setActions(button("cancel", t("cancel"), () => { back(); panel.focus(); }), yes);
		panel.focus();
	};
	// fork: `current` is the agent being edited, `shown` the fields on screen. A draft
	// restored after a cancelled deletion keeps the agent it edits: a new name in it is still a rename of that agent.
	const edit = (current, shown = current) => {
		panel.setTitle(current?.name ?? t("agentsNew"));
		const name = h("input", { class: "field", name: "name", value: shown?.name ?? "", required: true, dataset: current ? undefined : { autofocus: "" } });
		const purpose = h("input", { class: "field", name: "description", value: shown?.description ?? "", required: true, dataset: current ? { autofocus: "" } : undefined });
		const models = [...new Set([...data.models, ...(shown?.model ? [shown.model] : [])])];
		const model = h("select", { class: "field", name: "model" }, h("option", { value: "", text: t("agentsCurrentModel"), selected: !shown?.model }), models.map((value) => h("option", { value, text: value, selected: value === shown?.model })));
		const instructions = h("textarea", { class: "field", name: "instructions", rows: "6", text: shown?.instructions ?? "" });
		const tools = data.tools.map((tool) => h("label", { class: "native-menu-field" }, h("span", { text: tool }), h("input", { type: "checkbox", name: "tool", value: tool, checked: (shown?.tools ?? data.defaultTools).includes(tool) })));
		const save = button("save", t("sessionsSave"), () => form.requestSubmit(), true);
		const draft = () => ({ name: name.value, description: purpose.value, model: model.value, instructions: instructions.value, tools: [...form.querySelectorAll("input[name='tool']:checked")].map((input) => input.value) });
		const form = h("form", { class: "agents-form", onsubmit: async (event) => {
			event.preventDefault(); save.disabled = true;
			try {
				data = await view.engine.request({ type: "agents_save", ...(current ? { existingName: current.name } : {}), agent: draft() });
				if (!current) query = "";
				list(); panel.focus();
			} catch (error) { fail(error); }
			finally { save.disabled = false; }
		} }, row(t("nameLabel"), name), row(t("agentsPurpose"), purpose), row(t("model"), model), h("fieldset", {}, h("legend", { text: t("agentsTools") }), tools), row(t("agentsInstructions"), instructions));
		panel.setBody(form);
		panel.setActions(button("back", t("nativeBack"), () => { list(); panel.focus(); }), current && button("delete", t("sessionsDelete"), () => { const pending = draft(); confirm(t("agentsDelete"), t("agentsDeleteDetail", current.name), async () => { data = await view.engine.request({ type: "agents_remove", name: current.name }); list(); panel.focus(); }, () => edit(current, pending)); }), save);
		panel.focus();
	};
	const policy = () => {
		panel.setTitle(t("agentsPolicy"));
		const invocation = data.invocation;
		const mode = h("select", { class: "field", name: "mode", dataset: { autofocus: "" } }, h("option", { value: "auto", text: t("agentsAutomatic"), selected: invocation.autonomous }), h("option", { value: "request", text: t("agentsOnRequest"), selected: !invocation.autonomous }));
		const words = h("input", { type: "checkbox", name: "explicitRequest", checked: invocation.explicitRequest });
		const keyword = h("input", { type: "checkbox", name: "keyword", checked: invocation.keyword });
		const text = h("input", { class: "field", name: "keywordText", value: invocation.keywordText, maxLength: "32" });
		const save = button("policy-save", t("sessionsSave"), async () => {
			save.disabled = true;
			try { data = await view.engine.request({ type: "agents_policy", value: { autonomous: mode.value === "auto", explicitRequest: words.checked, keyword: keyword.checked, keywordText: text.value } }); policy(); panel.el.querySelector("[data-action='policy-save']")?.focus(); }
			catch (error) { fail(error); }
			finally { save.disabled = false; }
		}, true);
		panel.setBody(data.policyHelp.map((line) => h("p", { class: "panel-text muted", text: line })), row(t("agentsPolicy"), mode), row(t("agentsWords"), words), row(t("agentsKeyword"), keyword), row(t("agentsKeywordText"), text));
		panel.setActions(button("back", t("nativeBack"), () => { list(); panel.focus(); }), save);
		panel.focus();
	};
	list();
	await view.showPanel("agents", panel);
}
