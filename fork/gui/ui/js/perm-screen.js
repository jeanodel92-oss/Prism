// /perm in the window ("a real interface for permissions", "/perm scope is never discoverable", "the shortcuts are not shown")
// . The engine keeps the decisions and gives the state (rpc-builtins.ts, perm_*);
// this panel draws it in four tabs and sends each change back. Every answer carries the new state.

import { Panel, Segmented } from "./components.js";
import { clear, h } from "./dom.js";
import { t } from "./i18n.js";
import { keyText } from "./keys.js";
import { renderMarkdown } from "./markdown.js";

const MARKS = { allow: "✓", ask: "?", danger: "?!", block: "✗" };
const SAVED_EFFECTS = ["allow", "ask", "deny"];

/** The permissions screen; `tab` opens on one of "modes", "active", "rules", "help". */
export async function permScreen(view, tab = "modes") {
	let state = (await view.engine.request({ type: "perm_get" })).state;
	const panel = new Panel({ title: t("permTitle"), kind: "report perm" });
	const content = h("div", { class: "perm-content" });
	let current = tab;

	// One change at a time: the controls are inert while the engine answers (a mode may ask a question first).
	let busy = false;
	const send = async (command) => {
		if (busy) return;
		busy = true;
		panel.el.dataset.busy = "true";
		try {
			const answer = await view.engine.request(command);
			state = answer.state;
			if (answer.error) view.app.toast(answer.error, "warning");
		} catch (error) {
			view.app.toast(String(error?.message ?? error), "error");
		} finally {
			busy = false;
			delete panel.el.dataset.busy;
			draw();
		}
	};

	const modeName = (mode) => state.modes.find((entry) => entry.mode === mode)?.label ?? mode;
	const subtitle = () => t("permSubtitle", modeName(state.mode), modeName(state.defaultMode));

	const modes = () => {
		const cards = state.modes.map((entry) => {
			const on = entry.mode === state.mode;
			const sandbox = h(
				"label",
				{ class: "perm-sandbox switch", title: t("permSandboxHelp") },
				h("input", {
					type: "checkbox",
					checked: entry.sandbox === "on",
					onchange: (event) => send({ type: "perm_sandbox", mode: entry.mode, on: event.target.checked }),
				}),
				h("span", { text: t("permSandbox") }),
			);
			return h(
				"div",
				{ class: `perm-mode${on ? " current" : ""}`, dataset: { mode: entry.mode } },
				h(
					"button",
					{
						type: "button",
						class: "perm-mode-pick",
						role: "radio",
						"aria-checked": String(on),
						onclick: () => on || send({ type: "perm_mode", mode: entry.mode }),
					},
					h("span", { class: "perm-mode-name", text: entry.label }),
					entry.mode === state.defaultMode && h("span", { class: "badge", text: t("permDefault") }),
					on && h("span", { class: "badge accent", text: t("permCurrent") }),
					h("span", { class: "perm-mode-summary", text: entry.summary }),
				),
				sandbox,
			);
		});
		const running = state.sandbox.problem
			? h("p", { class: "panel-text warning", text: t("permSandboxBroken", state.sandbox.problem) })
			: h("p", { class: "panel-text muted", text: state.sandbox.running ? t("permSandboxRunning") : t("permSandboxOff", modeName(state.mode)) });
		const table = h(
			"table",
			{ class: "perm-policy" },
			h("thead", {}, h("tr", {}, h("th", { text: "" }), state.modes.map((entry) => h("th", { scope: "col", class: entry.mode === state.mode ? "current" : "", text: entry.label })))),
			h(
				"tbody",
				{},
				state.rows.map((row) =>
					h(
						"tr",
						{ dataset: { row: row.row } },
						h("th", { scope: "row", text: row.label }),
						state.modes.map((entry) => {
							const verdict = row.verdicts[entry.mode];
							return h("td", { class: `verdict ${verdict}${entry.mode === state.mode ? " current" : ""}`, title: t(`verdict.${verdict}`), "aria-label": t(`verdict.${verdict}`), text: MARKS[verdict] });
						}),
					),
				),
			),
		);
		const legend = h("p", { class: "panel-text muted perm-legend", text: Object.entries(MARKS).map(([verdict, mark]) => `${mark} ${t(`verdict.${verdict}`)}`).join("   ") });
		return [
			h("div", { class: "perm-modes", role: "radiogroup", "aria-label": t("permModes") }, cards),
			running,
			state.mode !== state.defaultMode &&
				h("button", { type: "button", class: "perm-keep", text: t("permMakeDefault", modeName(state.mode)), onclick: () => send({ type: "perm_mode", mode: state.mode, asDefault: true }) }),
			h("h3", { class: "perm-heading", text: t("permPolicy") }),
			table,
			legend,
		];
	};

	const active = () => {
		const grants = state.grants.length
			? h(
					"ul",
					{ class: "perm-grants" },
					state.grants.map((grant) =>
						h(
							"li",
							{ dataset: { effect: grant.effect } },
							h("span", { class: `perm-effect ${grant.effect}`, text: t(`effect.${grant.effect}`) }),
							h("span", { class: "perm-what", text: grant.what }),
							h("span", { class: "perm-scope muted", text: [grant.scope, grant.left].filter(Boolean).join(" · ") }),
							h("button", { type: "button", class: "ghost", text: t("permRevoke"), onclick: () => send({ type: "perm_revoke", index: grant.index, what: grant.what }) }),
						),
					),
				)
			: h("p", { class: "panel-text muted", text: t("permNoGrants") });
		const scope = state.scope
			? h(
					"div",
					{ class: "perm-task-scope" },
					h("p", { class: "panel-text", text: t(state.scope.away ? "permScopeAway" : "permScopeStay", state.scope.minutesLeft) }),
					h("ul", {}, state.scope.items.map((item) => h("li", { text: item }))),
					state.scope.limits.length > 0 && h("p", { class: "panel-text muted", text: state.scope.limits.join(" ") }),
					// the scope is described above; its end is one button, not a second dialog.
					h("button", { type: "button", text: t("permScopeEnd"), onclick: () => send({ type: "perm_scope_end" }) }),
				)
			: h(
					"div",
					{ class: "perm-task-scope" },
					h("p", { class: "panel-text muted", text: t("permScopeExplain") }),
					h("button", { type: "button", text: t("permScopeSet"), onclick: () => send({ type: "perm_scope" }) }),
				);
		return [h("h3", { class: "perm-heading", text: t("permActive") }), grants, h("h3", { class: "perm-heading", text: t("permScope") }), scope];
	};

	let ruleWhere = "session";
	const rules = () => {
		const session = { where: "session", file: "", read: true, allow: state.sessionRules?.allow ?? [], ask: [], deny: state.sessionRules?.deny ?? [] };
		const sources = { session, ...Object.fromEntries(state.saved.map((source) => [source.where, source])) };
		const source = sources[ruleWhere];
		const where = new Segmented({
			label: t("permRules"),
			value: ruleWhere,
			options: ["session", "project", "global"].map((value) => ({ value, label: t(`permWhere.${value}`) })),
			onChange: (value) => {
				ruleWhere = value;
				draw();
			},
		});
		const effects = ruleWhere === "session" ? ["allow", "deny"] : SAVED_EFFECTS;
		const lists = effects.map((effect) =>
			h(
				"div",
				{ class: "perm-rule-group", dataset: { effect } },
				h("h4", { text: t(`ruleEffect.${effect}`) }),
				source[effect].length
					? h(
							"ul",
							{ class: "perm-rules" },
							source[effect].map((rule) =>
								h(
									"li",
									{},
									h("code", { text: rule }),
									h("button", { type: "button", class: "ghost", text: t("permRuleRemove"), onclick: () => send({ type: "perm_rule", action: "remove", effect, rule, where: ruleWhere }) }),
								),
							),
						)
					: h("p", { class: "panel-text muted", text: t("permNoRules") }),
			),
		);
		const effect = h("select", { class: "field", "aria-label": t("permRuleEffect") }, effects.map((value) => h("option", { value, text: t(`ruleEffect.${value}`) })));
		const rule = h("input", { class: "field", type: "text", placeholder: "bash(npm run test*)", "aria-label": t("permRuleText"), spellcheck: "false" });
		const add = h("form", {
			class: "perm-rule-add",
			onsubmit: (event) => {
				event.preventDefault();
				if (rule.value.trim()) send({ type: "perm_rule", action: "add", effect: effect.value, rule: rule.value.trim(), where: ruleWhere });
			},
		}, effect, rule, h("button", { type: "submit", text: t("permRuleAdd") }));
		return [
			where.el,
			source.file && h("p", { class: "panel-text muted", text: source.read ? t("permRulesFile", source.file) : t("permNotTrusted", source.file) }),
			ruleWhere === "session" && h("p", { class: "panel-text muted", text: t("permSessionRules") }),
			...lists,
			source.read && add,
			h("p", { class: "panel-text muted", text: t("permRuleSyntax") }),
		];
	};

	const help = () => [
		h("h3", { class: "perm-heading", text: t("permShortcuts") }),
		h(
			"table",
			{ class: "keys-table" },
			h("tbody", {}, state.shortcuts.map((entry) => h("tr", {}, h("td", {}, h("kbd", { text: keyText(entry.keys) })), h("td", { text: entry.action })))),
		),
		h("div", { class: "perm-help markdown" }, renderMarkdown(state.help)),
	];

	const tabs = { modes, active, rules, help };
	const choice = new Segmented({
		label: t("permTitle"),
		value: current,
		options: [
			{ value: "modes", label: t("permTabModes") },
			{ value: "active", label: t("permTabActive", state.grants.length + (state.scope ? 1 : 0)) },
			{ value: "rules", label: t("permTabRules") },
			{ value: "help", label: t("permTabHelp") },
		],
		onChange: (value) => {
			current = value;
			draw();
		},
	});
	const draw = () => {
		panel.setTitle(t("permTitle"), subtitle());
		const label = choice.buttons.find((button) => button.dataset.value === "active");
		if (label) label.textContent = t("permTabActive", state.grants.length + (state.scope ? 1 : 0));
		// Redrawing keeps the place in the list and the field being typed in, when it is still there.
		const scroll = content.scrollTop;
		clear(content);
		content.append(...tabs[current]().filter(Boolean));
		content.scrollTop = scroll;
	};
	panel.setBody(choice.el, content);
	draw();
	await view.showPanel("perm", panel);
}
