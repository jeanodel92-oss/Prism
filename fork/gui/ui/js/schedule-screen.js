// /schedule in the window (native screens instead of a chain of questions). The tasks on the left, the chosen
// one on the right, or the form that creates one: everything `/schedule` asks, on one page. What the task may do is
// shown in full and confirmed before anything is written; the engine checks and installs (schedule-command.ts, schedule_*).

import { ListBox, Panel } from "./components.js";
import { clear, h } from "./dom.js";
import { t } from "./i18n.js";

const WHEN_PRESETS = [
	["scheduleDaily", "*-*-* 09:00"],
	["scheduleWeekdays", "Mon..Fri 09:00"],
	["scheduleWeekly", "Mon 09:00"],
	["scheduleHourly", "hourly"],
];

// `options`: `task`, the task shown first; `create`, the creation form first.
export async function scheduleScreen(view, _args, options = {}) {
	let state = (await view.engine.request({ type: "schedule_get" })).state;
	const { labels } = state;
	const panel = new Panel({ title: labels.title, kind: "report schedule" });
	const detail = h("div", { class: "schedule-detail" });
	let chosen = state.tasks.some((task) => task.id === options.task) ? options.task : state.tasks[0]?.id;
	let creating = !state.unsafe && (options.create === true || state.tasks.length === 0);
	// The summary to confirm, with the form it was made from and its fingerprint: Create sends exactly that form, not
	// the fields as they are now.
	let review;
	let sure = false; // the removal's second step
	const form = { prompt: "", name: "", when: "", files: false, commands: false, hosts: "", minutes: "30", tools: "100", catchUp: "report" };

	const request = async (command) => {
		panel.el.dataset.busy = "true";
		try {
			const answer = await view.engine.request(command);
			state = answer.state;
			if (answer.error) view.app.toast(answer.error, "warning");
			return answer;
		} catch (error) {
			view.app.toast(String(error?.message ?? error), "error");
			return { error: true };
		} finally {
			delete panel.el.dataset.busy;
		}
	};

	const list = new ListBox({
		items: [],
		empty: t("scheduleNone"),
		onChoose: (item) => {
			chosen = item.value;
			creating = false;
			review = undefined;
			sure = false;
			draw();
		},
	});

	const field = (label, input) => h("label", {}, h("span", { text: label }), input);
	const text = (key, attrs = {}) =>
		h("input", {
			class: "field",
			type: "text",
			spellcheck: "false",
			value: form[key],
			dataset: { field: key },
			oninput: (event) => {
				form[key] = event.target.value;
			},
			...attrs,
		});
	const check = (key, label) =>
		h(
			"label",
			{ class: "sandbox-field sandbox-switch" },
			h("input", {
				type: "checkbox",
				checked: form[key],
				dataset: { field: key },
				onchange: (event) => {
					form[key] = event.target.checked;
				},
			}),
			h("span", { class: "sandbox-label", text: label }),
		);

	// the usual times offered, the calendar expression only for what they do not cover.
	const whenField = () => {
		const input = text("when", { placeholder: t("scheduleWhenHint"), "aria-label": t("scheduleWhenCustom") });
		return h(
			"div",
			{ class: "schedule-when" },
			h("span", { text: t("scheduleWhen") }),
			h(
				"div",
				{ class: "schedule-presets" },
				WHEN_PRESETS.map(([key, when]) =>
					h("button", {
						type: "button",
						text: t(key),
						dataset: { when },
						onclick: () => {
							form.when = when;
							input.value = when;
						},
					}),
				),
			),
			h("label", {}, h("span", { class: "sandbox-help", text: t("scheduleWhenCustom") }), input),
		);
	};

	const creation = () => {
		if (review)
			return [
				h("pre", { class: "schedule-summary", tabindex: "0", text: review.summary }),
				h(
					"div",
					{ class: "schedule-actions" },
					h("button", {
						type: "button",
						class: "primary",
						dataset: { action: "create" },
						text: labels.create,
						onclick: async () => {
							const shown = review;
							const answer = await request({ type: "schedule_create", form: shown.form, fingerprint: shown.fingerprint });
							if (answer.error) review = undefined;
							else {
								view.app.toast(t("scheduleCreated", shown.form.name.trim()));
								chosen = shown.form.name.trim();
								creating = false;
								review = undefined;
								Object.assign(form, { prompt: "", name: "", when: "", files: false, commands: false, hosts: "" });
							}
							draw();
						},
					}),
					h("button", {
						type: "button",
						class: "ghost",
						text: t("scheduleBack"),
						onclick: () => {
							review = undefined;
							draw();
						},
					}),
				),
			];
		const prompt = h("textarea", {
			class: "field",
			text: form.prompt,
			dataset: { field: "prompt", autofocus: "" },
			oninput: (event) => {
				form.prompt = event.target.value;
			},
		});
		const catchUp = h(
			"select",
			{
				class: "field",
				dataset: { field: "catchUp" },
				onchange: (event) => {
					form.catchUp = event.target.value;
				},
			},
			h("option", { value: "report", text: labels.report, selected: form.catchUp === "report" }),
			h("option", { value: "run", text: labels.late, selected: form.catchUp === "run" }),
		);
		return [
			h(
				"form",
				{
					class: "schedule-form",
					onsubmit: async (event) => {
						event.preventDefault();
						const sent = { ...form };
						const answer = await request({ type: "schedule_preview", form: sent });
						if (answer.summary) {
							review = { summary: answer.summary, form: sent, fingerprint: answer.fingerprint };
							draw();
						}
					},
				},
				field(labels.prompt, prompt),
				field(labels.name, text("name", { placeholder: "nightly-tests" })),
				whenField(),
				check("files", labels.files),
				check("commands", labels.commands),
				field(labels.hosts, text("hosts", { placeholder: "api.github.com" })),
				h("div", { class: "schedule-limits" }, field(labels.minutes, text("minutes", { inputmode: "numeric" })), field(labels.tools, text("tools", { inputmode: "numeric" }))),
				field(labels.catchUp, catchUp),
				h("div", { class: "schedule-actions" }, h("button", { type: "submit", class: "primary", dataset: { action: "review" }, text: t("scheduleReview") })),
			),
		];
	};

	const taskDetail = (task) => [
		h("h3", { class: "tutorial-title", text: task.id }),
		h("p", { class: "panel-text" }, h("code", { text: task.when }), " · ", h("span", { dataset: { state: task.active ? "active" : "paused" }, class: "schedule-state", text: task.active ? labels.active : labels.paused })),
		h("p", { class: "panel-text", text: task.prompt }),
		h("p", { class: "panel-text muted", text: task.cwd }),
		h("p", { class: "panel-text muted", text: task.limits }),
		h("h4", { class: "perm-heading", text: task.runs.length > 0 ? labels.lastRuns : labels.noRun }),
		task.runs.length > 0 && h("ul", { class: "perm-rules" }, task.runs.map((run) => h("li", { text: run }))),
		h(
			"div",
			{ class: "schedule-actions" },
			h("button", {
				type: "button",
				dataset: { action: "pause" },
				text: task.active ? labels.pause : labels.resume,
				onclick: async () => {
					await request({ type: "schedule_pause", task: task.id, paused: task.active });
					draw();
				},
			}),
			h("button", {
				type: "button",
				class: "ghost",
				dataset: { action: "remove" },
				text: sure ? labels.removeSure : labels.remove,
				onclick: async () => {
					if (!sure) sure = true;
					else {
						await request({ type: "schedule_remove", task: task.id });
						sure = false;
						chosen = state.tasks[0]?.id;
					}
					draw();
				},
			}),
		),
	];

	const draw = () => {
		list.setItems(
			state.tasks.map((task) => ({ label: task.id, meta: task.active ? "" : labels.paused, description: task.when, value: task.id, current: task.id === chosen && !creating })),
			Math.max(0, state.tasks.findIndex((task) => task.id === chosen)),
		);
		clear(detail);
		const task = state.tasks.find((entry) => entry.id === chosen);
		if (state.unsafe) detail.append(h("p", { class: "panel-text warning", text: state.unsafe }));
		if (creating && !state.unsafe) detail.append(...creation());
		else if (task) detail.append(...taskDetail(task).filter(Boolean));
		else if (!state.unsafe) detail.append(h("p", { class: "panel-text muted", text: t("scheduleNone") }));
		detail.querySelector("[data-autofocus]")?.focus({ preventScroll: true });
	};

	const add = h("button", {
		type: "button",
		dataset: { action: "new" },
		disabled: Boolean(state.unsafe),
		text: labels.new,
		onclick: () => {
			creating = true;
			review = undefined;
			sure = false;
			draw();
		},
	});
	panel.setBody(h("div", { class: "schedule-layout" }, h("div", { class: "schedule-side" }, add, list.el), detail));
	draw();
	await view.showPanel("schedule", panel);
}
