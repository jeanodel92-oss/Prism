// Agent files and invocation rules remain owned and validated by the engine.
import { ListBox, Panel } from "./components.js";
import { h } from "./dom.js";
import { t } from "./i18n.js";

export async function agentsScreen(view, args = "", open = "list") {
	// /agents fork <task> starts the agent at once, as in the terminal.
	const forkArgs = /^fork(?:\s+([\s\S]*))?$/.exec(args.trim());
	if (forkArgs?.[1]?.trim()) {
		try {
			const started = await view.engine.request({ type: "agents_fork", task: forkArgs[1] });
			view.app.toast(t("agentsStarted", "fork", started.started));
		} catch (error) { view.app.toast(error.message, "error"); }
		return;
	}
	let data = await view.engine.request({ type: "agents_get" });
	const panel = new Panel({ title: t("agentsTitle"), kind: "report agents" });
	let query = "";
	const fail = (error) => view.app.toast(error.message, "error");
	const button = (action, text, onclick, primary = false) => h("button", { type: "button", class: primary ? "primary" : "", text, dataset: { action }, onclick });
	const row = (label, input) => h("label", { class: input.type === "checkbox" ? "native-menu-field" : "field-row" }, h("span", { text: label }), input);
	const engineMeta = (agent) => `${agent.model || t("agentsCurrentModel")}${agent.thinking ? ` · ${agent.thinking}` : ""}`;
	// the advanced mode adds to the normal one. With it on, the general agent and the
	// preconfigured ones turned on are listed with the user's own, each with the model and effort it runs on.
	const builtIn = () => {
		if (!data.advanced?.on) return [];
		const offered = new Set((data.available ?? []).map((agent) => agent.name));
		return (data.advanced.builtin ?? []).filter((agent) => offered.has(agent.name) && !data.agents.some((own) => own.name === agent.name));
	};
	const list = () => {
		panel.setTitle(t("agentsTitle"));
		const choices = new ListBox({
			items: [
				...builtIn().map((agent) => ({ value: { builtIn: agent }, label: agent.name, description: agent.description, meta: `${t("agentsBuiltIn")} · ${engineMeta(agent)}` })),
				...data.agents.map((agent) => ({ value: agent, label: agent.name, description: agent.description, meta: engineMeta(agent), searchText: agent.tools.join(" ") })),
			],
			filter: "fuzzy", placeholder: t("ctxSearch"), empty: t("agentsNone"), onChoose: ({ value }) => (value.builtIn ? engine(value.builtIn) : edit(value)),
		});
		choices.field.value = query;
		choices.field.addEventListener("input", () => { query = choices.field.value; });
		choices.field.dispatchEvent(new Event("input"));
		// the agents running in the background, each with Stop.
		const running = (data.running ?? []).length ? h("section", { class: "agents-running" }, h("h3", { text: t("agentsRunning") }), data.running.map((run) => h("div", { class: "agents-run", dataset: { run: run.id } },
			h("span", { text: `${run.agent} (${run.id}) · ${run.step}` }),
			button("stop", t("agentsStop"), () => confirm(t("agentsStopTitle", run.agent), t("agentsStopDetail"), async () => { data = await view.engine.request({ type: "agents_stop", run: run.id }); list(); panel.focus(); })),
		))) : undefined;
		const help = [...data.help, ...(data.advanced?.on ? [t("agentsAdvancedHelp")] : [])];
		panel.setBody(help.map((text) => h("p", { class: "panel-text muted", text })), running, choices.el);
		// run an agent, and the advanced mode with its warning, presets and limit.
		panel.setActions(
			data.available?.length ? button("run", t("agentsRun"), launch) : undefined,
			data.advanced?.on ? button("fork", t("agentsFork"), fork) : undefined,
			button("new", t("agentsNew"), () => edit()),
			button("policy", t("agentsPolicy"), policy),
			data.advanced && button("advanced", t(data.advanced.on ? "agentsAdvancedStateOn" : "agentsAdvancedStateOff"), advanced),
			button("off", t("agentsOff"), () => confirm(t("agentsOff"), data.offDetail, async () => {
				await view.engine.request({ type: "agents_disable" });
				await reload(t("agentsDisabled"));
			})),
		);
	};
	// The agent tool changes: it applies by reloading, as turning agents off does.
	const reload = async (done, reopen) => {
		panel.done();
		const result = await view.engine.request({ type: "reload" });
		await view.refreshResources();
		if (result.error) view.app.toast(result.error, "warning");
		else view.app.toast(done);
		// turning the advanced mode on goes on to the preconfigured agents.
		if (reopen && !result.error) void agentsScreen(view, "", reopen);
	};
	const back = () => button("back", t("nativeBack"), () => { list(); panel.focus(); });
	const modelSelect = (current) => {
		const models = [...new Set([...data.models, ...(current ? [current] : [])])];
		return h("select", { class: "field", name: "model" }, h("option", { value: "", text: t("agentsCurrentModel"), selected: !current }), models.map((value) => h("option", { value, text: value, selected: value === current })));
	};
	const effortSelect = (current) => h("select", { class: "field", name: "thinking" }, h("option", { value: "", text: t("agentsModelEffort"), selected: !current }), (data.thinkingLevels ?? []).map((value) => h("option", { value, text: value, selected: value === current })));
	// the model and effort of the general agent or a preconfigured one.
	const engine = (agent) => {
		panel.setTitle(agent.name);
		const model = modelSelect(agent.model);
		const thinking = effortSelect(agent.thinking);
		model.dataset.autofocus = "";
		const save = button("builtin-save", t("sessionsSave"), async () => {
			save.disabled = true;
			try {
				data = await view.engine.request({ type: "agents_builtin", name: agent.name, model: model.value, thinking: thinking.value });
				view.app.toast(t("agentsSaved"));
				list(); panel.focus();
			} catch (error) { fail(error); }
			finally { save.disabled = false; }
		}, true);
		panel.setBody(h("p", { class: "panel-text muted", text: agent.description }), h("p", { class: "panel-text muted", text: t("agentsEngineHelp") }), row(t("model"), model), row(t("agentsEffort"), thinking));
		panel.setActions(back(), save);
		panel.focus();
	};
	const launch = () => {
		panel.setTitle(t("agentsRun"));
		const agent = h("select", { class: "field", name: "agent", dataset: { autofocus: "" } }, data.available.map((entry) => h("option", { value: entry.name, text: `${entry.name} — ${entry.description}` })));
		const task = h("textarea", { class: "field", name: "task", rows: "6" });
		const go = button("run-start", t("agentsRunStart"), async () => {
			go.disabled = true;
			try {
				const name = agent.value;
				data = await view.engine.request({ type: "agents_run", agent: name, task: task.value });
				view.app.toast(t("agentsStarted", name, data.started));
				list(); panel.focus();
			} catch (error) { fail(error); }
			finally { go.disabled = false; }
		}, true);
		panel.setBody(row(t("agentsWhich"), agent), row(t("agentsTask"), task));
		panel.setActions(back(), go);
		panel.focus();
	};
	// an agent that starts from a copy of this conversation, on the session's model.
	const fork = () => {
		panel.setTitle(t("agentsFork"));
		const task = h("textarea", { class: "field", name: "task", rows: "6", dataset: { autofocus: "" } });
		const go = button("fork-start", t("agentsRunStart"), async () => {
			go.disabled = true;
			try {
				data = await view.engine.request({ type: "agents_fork", task: task.value });
				view.app.toast(t("agentsStarted", "fork", data.started));
				list(); panel.focus();
			} catch (error) { fail(error); }
			finally { go.disabled = false; }
		}, true);
		panel.setBody(h("p", { class: "panel-text muted", text: t("agentsForkHelp") }), row(t("agentsTask"), task));
		panel.setActions(back(), go);
		panel.focus();
	};
	const advanced = () => {
		const settings = data.advanced;
		panel.setTitle(t("agentsAdvanced"));
		const toggle = (on) => async () => {
			await view.engine.request({ type: "agents_advanced", on });
			await reload(t(on ? "agentsAdvancedIsOn" : "agentsAdvancedIsOff"), on ? "advanced" : undefined);
		};
		if (!settings.on) {
			// The warning comes before it is on, in red.
			panel.setBody(h("p", { class: "panel-text", text: settings.detail }), h("p", { class: "panel-text dialog-warning", text: settings.warning }));
			const on = button("advanced-on", t("agentsAdvancedOn"), async () => { on.disabled = true; try { await toggle(true)(); } catch (error) { fail(error); } finally { on.disabled = false; } }, true);
			panel.setActions(back(), on);
			panel.focus();
			return;
		}
		panel.setTitle(t("agentsAdvancedStateOn"));
		const presets = settings.presets.map((preset) => h("label", { class: "native-menu-field" }, h("span", { text: `${preset.name} — ${preset.description}` }), h("input", { type: "checkbox", name: "preset", value: preset.name, checked: preset.on })));
		const count = h("input", { class: "field", type: "number", name: "maxParallel", min: "1", max: String(settings.maxLimit), step: "1", value: String(settings.maxParallel) });
		const save = button("advanced-save", t("sessionsSave"), async () => {
			save.disabled = true;
			try {
				await view.engine.request({ type: "agents_presets", names: [...panel.el.querySelectorAll("input[name='preset']:checked")].map((input) => input.value) });
				data = await view.engine.request({ type: "agents_parallel", count: Number(count.value) });
				view.app.toast(t("agentsSaved"));
				advanced();
			} catch (error) { fail(error); }
			finally { save.disabled = false; }
		}, true);
		const off = button("advanced-off", t("agentsAdvancedOff"), () => confirm(t("agentsAdvancedOff"), settings.detail, toggle(false), advanced));
		panel.setBody(h("p", { class: "panel-text muted", text: settings.detail }), h("fieldset", {}, h("legend", { text: t("agentsPresets") }), presets), row(t("agentsAtOnce"), count));
		panel.setActions(back(), off, save);
		panel.focus();
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
		const model = modelSelect(shown?.model);
		const thinking = effortSelect(shown?.thinking);
		const instructions = h("textarea", { class: "field", name: "instructions", rows: "6", text: shown?.instructions ?? "" });
		const tools = data.tools.map((tool) => h("label", { class: "native-menu-field" }, h("span", { text: tool }), h("input", { type: "checkbox", name: "tool", value: tool, checked: (shown?.tools ?? data.defaultTools).includes(tool) })));
		const save = button("save", t("sessionsSave"), () => form.requestSubmit(), true);
		const draft = () => ({ name: name.value, description: purpose.value, model: model.value, thinking: thinking.value, instructions: instructions.value, tools: [...form.querySelectorAll("input[name='tool']:checked")].map((input) => input.value) });
		const form = h("form", { class: "agents-form", onsubmit: async (event) => {
			event.preventDefault(); save.disabled = true;
			try {
				data = await view.engine.request({ type: "agents_save", ...(current ? { existingName: current.name } : {}), agent: draft() });
				if (!current) query = "";
				list(); panel.focus();
			} catch (error) { fail(error); }
			finally { save.disabled = false; }
		} }, row(t("nameLabel"), name), row(t("agentsPurpose"), purpose), row(t("model"), model), row(t("agentsEffort"), thinking), h("fieldset", {}, h("legend", { text: t("agentsTools") }), tools), row(t("agentsInstructions"), instructions));
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
		const help = [...data.policyHelp, ...(data.advanced?.on ? [t("agentsPolicyAll")] : [])];
		panel.setBody(help.map((line) => h("p", { class: "panel-text muted", text: line })), row(t("agentsPolicy"), mode), row(t("agentsWords"), words), row(t("agentsKeyword"), keyword), row(t("agentsKeywordText"), text));
		panel.setActions(button("back", t("nativeBack"), () => { list(); panel.focus(); }), save);
		panel.focus();
	};
	if (open === "advanced" && data.advanced?.on) advanced();
	else if (forkArgs && data.advanced?.on) fork();
	else list();
	await view.showPanel("agents", panel);
}
