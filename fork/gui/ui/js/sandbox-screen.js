// /sandbox in the window ("it only shows, it is not configurable, and the list still looks like the TUI")
// . The engine gives the settings of /settings › Permissions & sandbox as data and keeps them (sandbox-panel.ts);
// this panel draws them in tabs and sends each change back. Every answer carries the new state.

import { Panel, Segmented } from "./components.js";
import { clear, h } from "./dom.js";
import { t } from "./i18n.js";

/** The sandbox screen. */
export async function sandboxScreen(view) {
	let state = (await view.engine.request({ type: "sandbox_get" })).state;
	const panel = new Panel({ title: t("sandboxTitle"), kind: "report sandbox" });
	const content = h("div", { class: "sandbox-content" });
	// What was typed in each list, until it is added: a path refused stays there to be corrected.
	const drafts = new Map();
	const wheres = new Map();
	let current = state.sections[0]?.id;

	// One change at a time: the controls are inert while the engine answers.
	let busy = false;
	const send = async (command, added) => {
		if (busy) return;
		busy = true;
		panel.el.dataset.busy = "true";
		const focus = document.activeElement?.dataset?.control;
		try {
			const answer = await view.engine.request(command);
			state = answer.state;
			if (answer.error) view.app.toast(answer.error, "warning");
			else added?.();
		} catch (error) {
			view.app.toast(String(error?.message ?? error), "error");
		} finally {
			busy = false;
			delete panel.el.dataset.busy;
			draw();
			if (focus) content.querySelector(`[data-control="${CSS.escape(focus)}"]`)?.focus();
		}
	};

	const heading = (field) => [h("span", { class: "sandbox-label", text: field.label }), field.help && h("span", { class: "sandbox-help", text: field.help })].filter(Boolean);

	const toggle = (field) =>
		h(
			"label",
			{ class: "sandbox-field sandbox-switch", dataset: { field: field.id } },
			h("input", {
				type: "checkbox",
				checked: field.on,
				dataset: { control: field.id },
				onchange: (event) => send({ type: "sandbox_set", setting: field.id, value: event.target.checked }),
			}),
			h("span", { class: "sandbox-text" }, heading(field)),
		);

	const choice = (field) =>
		h(
			"div",
			{ class: "sandbox-field sandbox-choice", dataset: { field: field.id } },
			h("span", { class: "sandbox-text" }, heading(field)),
			new Segmented({
				label: field.label,
				value: field.value,
				options: field.options.map((value) => ({ value, label: value })),
				onChange: (value) => send({ type: "sandbox_set", setting: field.id, value }),
			}).el,
		);

	const list = (field) => {
		const input = h("input", {
			class: "field",
			type: "text",
			placeholder: field.placeholder,
			"aria-label": field.label,
			spellcheck: "false",
			value: drafts.get(field.id) ?? "",
			dataset: { control: `${field.id}:add` },
			oninput: (event) => drafts.set(field.id, event.target.value),
		});
		const where =
			field.where &&
			h(
				"select",
				{
					class: "field",
					"aria-label": t("sandboxWhere"),
					onchange: (event) => wheres.set(field.id, event.target.value),
				},
				field.where.map((option) => h("option", { value: option.value, text: option.label, selected: option.value === wheres.get(field.id) })),
			);
		return h(
			"div",
			{ class: "sandbox-field sandbox-list", dataset: { field: field.id } },
			h("span", { class: "sandbox-text" }, heading(field)),
			field.items.length > 0
				? h(
						"ul",
						{ class: "perm-rules" },
						field.items.map((item) =>
							h(
								"li",
								{},
								h("code", { text: item.text }),
								item.tag && h("span", { class: "badge", text: item.tag }),
								h("button", {
									type: "button",
									class: "ghost",
									text: t("permRuleRemove"),
									"aria-label": t("sandboxRemove", item.text),
									onclick: () => send({ type: "sandbox_list", setting: field.id, action: "remove", text: item.text, key: item.key }),
								}),
							),
						),
					)
				: h("p", { class: "panel-text muted", text: t("sandboxEmpty") }),
			h(
				"form",
				{
					class: "perm-rule-add",
					onsubmit: (event) => {
						event.preventDefault();
						if (!input.value.trim()) return;
						send({ type: "sandbox_list", setting: field.id, action: "add", text: input.value, where: where?.value }, () => drafts.delete(field.id));
					},
				},
				where,
				input,
				h("button", { type: "submit", text: t("permRuleAdd") }),
			),
		);
	};

	const fields = { switch: toggle, choice, list };

	const status = () =>
		state.status &&
		h(
			"div",
			{ class: "sandbox-status", dataset: { broken: String(Boolean(state.status.check)) } },
			h(
				"details",
				{},
				h("summary", { text: state.status.label }),
				state.status.lines.map((line) => h("p", { class: "panel-text", text: line })),
			),
			state.status.check && h("button", { type: "button", text: state.status.check, dataset: { control: "check" }, onclick: () => send({ type: "sandbox_check" }) }),
		);

	const tabs = new Segmented({
		label: t("sandboxTitle"),
		value: current,
		options: state.sections.map((section) => ({ value: section.id, label: section.title })),
		onChange: (value) => {
			current = value;
			content.scrollTop = 0;
			draw();
		},
	});

	const draw = () => {
		const section = state.sections.find((entry) => entry.id === current);
		tabs.el.hidden = !section;
		// Redrawing keeps the place in the list.
		const scroll = content.scrollTop;
		clear(content);
		if (state.problem) content.append(h("p", { class: "panel-text warning", text: state.problem }));
		content.append(
			...[status(), section?.help && h("p", { class: "panel-text muted", text: section.help }), ...(section?.fields ?? []).map((field) => fields[field.kind](field))].filter(Boolean),
		);
		content.scrollTop = scroll;
	};

	panel.setBody(tabs.el, content);
	draw();
	await view.showPanel("sandbox", panel);
}
