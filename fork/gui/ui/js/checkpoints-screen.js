// Checkpoint operations stay in the loaded module. A review token prevents applying a stale list of files.
import { facts, ListBox, Panel } from "./components.js";
import { h } from "./dom.js";
import { t } from "./i18n.js";

export async function checkpointsScreen(view, undo = false) {
	const panel = new Panel({ title: t("checkpointsTitle"), kind: "report checkpoints" });
	let lastResult;
	let query = "";
	const list = async () => {
		const { turns } = await view.engine.request({ type: "checkpoints_get" });
		panel.setTitle(t("checkpointsTitle"));
		panel.setActions();
		const result = lastResult && h("div", { role: "status" },
			h("p", { class: "panel-text", text: t("checkpointsResult", lastResult.restored, lastResult.removed, lastResult.failed.length) }),
			lastResult.failed.map((text) => h("p", { class: "panel-text warning", text })),
		);
		if (!turns.length) panel.setBody(result, h("p", { class: "panel-text muted", text: t("checkpointsNone") }));
		else {
			const choices = new ListBox({
				items: turns.map((entry) => ({ value: entry.turn, label: t("checkpointTurn", entry.turn), meta: entry.ts, description: entry.files.join("\n") })),
				filter: "fuzzy", placeholder: t("ctxSearch"), empty: t("noMatch"),
				onChoose: (entry) => review(entry.value).catch((error) => view.app.toast(error.message, "error")),
			});
			choices.field.value = query;
			choices.field.addEventListener("input", () => { query = choices.field.value; });
			choices.field.dispatchEvent(new Event("input"));
			panel.setBody(result, choices.el);
		}
		return turns;
	};
	const review = async (turn) => {
		const plan = await view.engine.request({ type: "checkpoints_preview", turn });
		panel.setTitle(t("checkpointRestore", turn));
		panel.setBody(
			h("p", { class: "panel-text", text: t("checkpointsExplain") }),
			facts(plan.files.map((file) => [t(`checkpoint.${file.action}`), file.path])),
			plan.skipped.length > 0 && h("div", {}, h("p", { class: "panel-text warning", text: t("checkpointsSkipped") }), plan.skipped.map((path) => h("p", { class: "panel-text", text: path }))),
			h("p", { class: "panel-text muted", text: t("checkpointsBash") }),
		);
		const apply = h("button", { type: "button", class: "primary", text: t("confirm"), onclick: async () => {
			apply.disabled = true;
			try {
				lastResult = await view.engine.request({ type: "checkpoints_restore", turn, revision: plan.revision });
				await list();
				panel.focus();
			} catch (error) {
				view.app.toast(error.message, "error");
			} finally { apply.disabled = false; }
		} });
		panel.setActions(h("button", { type: "button", text: t("nativeBack"), onclick: () => list().then(() => panel.focus()).catch((error) => view.app.toast(error.message, "error")) }), apply);
		panel.focus();
	};
	const turns = await list();
	if (undo && turns.length) await review(turns[0].turn);
	await view.showPanel(undo ? "undo" : "checkpoints", panel);
}
