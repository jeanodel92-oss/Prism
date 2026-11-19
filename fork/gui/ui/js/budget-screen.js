// /budget in the window (native screens instead of a line of text). Each limit with what the session used,
// a gauge and a field; the engine keeps the budgets and refuses what it must (budgets.ts, rpc-builtins.ts, budget_*).

import { Panel } from "./components.js";
import { clear, h } from "./dom.js";
import { t } from "./i18n.js";

const REFRESH_MS = 2000;

const gauge = (entry) =>
	h(
		"div",
		{
			class: "budget-gauge",
			role: "meter",
			"aria-valuemin": "0",
			"aria-valuemax": "1",
			"aria-valuenow": String(entry.fraction),
			"aria-label": entry.limitText,
			dataset: { high: String(entry.fraction >= 0.8) },
		},
		h("div", { style: `width: ${Math.min(100, entry.fraction * 100)}%` }),
	);

export async function budgetScreen(view) {
	let state = (await view.engine.request({ type: "budget_get" })).state;
	const panel = new Panel({ title: t("budgetTitle"), subtitle: t("budgetSubtitle"), kind: "report budget" });
	const rows = h("tbody");
	const notes = h("div", { class: "budget-notes" });
	const inputs = new Map();

	const send = async (kind, value) => {
		try {
			const answer = await view.engine.request({ type: "budget_set", kind, value });
			state = answer.state;
			if (answer.error) view.app.toast(answer.error, "warning");
			else inputs.get(kind)?.setCustomValidity("");
		} catch (error) {
			view.app.toast(String(error?.message ?? error), "error");
		}
		draw(true);
	};

	const row = (entry) => {
		const input = h("input", {
			class: "field",
			type: "number",
			min: "0",
			step: "any",
			value: entry.limit ?? "",
			"aria-label": `${t("budgetLimit")} ${entry.label}`,
			disabled: !entry.available && entry.limit === null,
		});
		inputs.set(entry.kind, input);
		return h(
			"tr",
			{ dataset: { kind: entry.kind, blocked: String(state.blocked === entry.kind) } },
			h("th", { scope: "row", text: entry.label }),
			h(
				"td",
				{ class: "budget-used" },
				entry.used,
				entry.limit !== null && gauge(entry),
			),
			h(
				"td",
				{},
				h(
					"form",
					{
						class: "budget-form",
						onsubmit: (event) => {
							event.preventDefault();
							const value = Number(input.value);
							if (input.value.trim() === "" || !Number.isFinite(value) || value <= 0) {
								view.app.toast(t("budgetInvalid"), "warning");
								return;
							}
							send(entry.kind, value);
						},
					},
					input,
					h("button", { type: "submit", text: t("budgetSet"), disabled: !entry.available }),
					entry.limit !== null && h("button", { type: "button", class: "ghost", text: t("budgetOff"), onclick: () => send(entry.kind, null) }),
				),
				!entry.available && h("span", { class: "sandbox-help", text: t("budgetNoPrice") }),
				state.blocked === entry.kind && h("span", { class: "panel-text warning", text: t("budgetBlocked") }),
			),
		);
	};

	/** `all`: the limits changed, so the fields too; otherwise only what the session used, and what is typed stays. */
	const draw = (all = false) => {
		if (all || rows.childElementCount === 0) {
			clear(rows);
			inputs.clear();
			rows.append(...state.rows.map(row));
			clear(notes);
			notes.append(...state.notes.map((text) => h("p", { class: "panel-text muted", text })));
			return;
		}
		for (const entry of state.rows) {
			const line = rows.querySelector(`tr[data-kind="${entry.kind}"]`);
			const used = line?.querySelector(".budget-used");
			if (used?.firstChild) used.firstChild.textContent = entry.used;
			used?.querySelector(".budget-gauge")?.replaceWith(gauge(entry));
			if (line) line.dataset.blocked = String(state.blocked === entry.kind);
		}
	};

	panel.setBody(
		h(
			"table",
			{ class: "budget-table" },
			h("thead", {}, h("tr", {}, h("th", { scope: "col", text: t("budgetKind") }), h("th", { scope: "col", text: t("budgetUsed") }), h("th", { scope: "col", text: t("budgetLimit") }))),
			rows,
		),
		notes,
	);
	draw(true);
	const timer = setInterval(async () => {
		try {
			state = (await view.engine.request({ type: "budget_get" })).state;
			draw();
		} catch {
			// The engine stopped: the panel closes with its view.
		}
	}, REFRESH_MS);
	try {
		await view.showPanel("budget", panel);
	} finally {
		clearInterval(timer);
	}
}
