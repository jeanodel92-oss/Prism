// /bg in the window.
// The tasks on the left, the chosen one's output on the right, refreshed while the panel is open; stopping and
// forgetting go to the engine (rpc-builtins.ts, bg_*), which answers with the list after the change.

import { Panel } from "./components.js";
import { clear, formatDuration, h } from "./dom.js";
import { t } from "./i18n.js";

const REFRESH_MS = 1500;
const ENDED = new Set(["done", "failed", "stopped", "timed_out"]);

export async function bgScreen(view) {
	let { tasks } = await view.engine.request({ type: "bg_list" });
	let chosen = tasks.find((task) => task.status === "running")?.id ?? tasks.at(-1)?.id;
	const panel = new Panel({ title: t("bgTitle"), kind: "report bg" });
	const list = h("ul", { class: "bg-list", role: "listbox", "aria-label": t("bgTitle") });
	const detail = h("div", { class: "bg-detail" });
	const output = h("pre", { class: "bg-output", tabindex: "0", "aria-label": t("bgOutput") });
	let follow = true; // the output stays at its end until the user scrolls up
	output.addEventListener("scroll", () => {
		follow = output.scrollTop + output.clientHeight >= output.scrollHeight - 4;
	});

	const ago = (task) => {
		const end = task.endedAt ?? Date.now();
		return formatDuration(Math.max(0, end - task.startedAt));
	};
	const drawList = () => {
		clear(list);
		if (tasks.length === 0) list.append(h("li", { class: "bg-empty muted", text: t("bgNone") }));
		for (const task of [...tasks].reverse())
			list.append(
				h(
					"li",
					{
						role: "option",
						tabindex: "0",
						"aria-selected": String(task.id === chosen),
						dataset: { status: task.status, id: task.id },
						onclick: () => choose(task.id),
						onkeydown: (event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								choose(task.id);
							}
						},
					},
					h("span", { class: "bg-state", title: task.statusLabel }),
					h("span", { class: "bg-command", text: task.command }),
					h("span", { class: "bg-meta muted", text: `${task.id} · ${task.statusLabel} · ${ago(task)}${task.exitCode !== undefined ? ` · ${t("bgExit", task.exitCode)}` : ""}` }),
				),
			);
	};
	const drawDetail = async () => {
		const task = tasks.find((entry) => entry.id === chosen);
		clear(detail);
		if (!task) {
			detail.append(h("p", { class: "panel-text muted", text: t("bgChoose") }));
			return;
		}
		const stop =
			(task.status === "running" || task.status === "stopping") &&
			h("button", { type: "button", class: "danger", text: task.status === "stopping" ? t("bgStopping") : t("bgStop"), disabled: task.status === "stopping", onclick: () => act({ type: "bg_stop", task: task.id }) });
		detail.append(
			h("div", { class: "bg-head" }, h("code", { class: "bg-full-command", text: task.command }), stop),
			h("p", { class: "panel-text muted", text: t("bgWhere", task.cwd) }),
			output,
		);
		await refreshOutput();
	};
	// Only the text changes while a task runs: the buttons stay where the pointer is.
	const refreshOutput = async () => {
		if (!chosen) return;
		const { log } = await view.engine.request({ type: "bg_log", task: chosen }).catch(() => ({ log: "" }));
		const text = log || t("bgNoOutput");
		if (output.textContent !== text) {
			output.textContent = text;
			if (follow) output.scrollTop = output.scrollHeight;
		}
	};
	const choose = (id) => {
		chosen = id;
		follow = true;
		drawList();
		drawDetail();
	};
	const act = async (command) => {
		try {
			const answer = await view.engine.request(command);
			tasks = answer.tasks;
			if (answer.error) view.app.toast(answer.error, "warning");
		} catch (error) {
			view.app.toast(String(error?.message ?? error), "error");
		}
		if (!tasks.some((task) => task.id === chosen)) chosen = tasks.at(-1)?.id;
		drawList();
		await drawDetail();
		drawActions();
	};
	const drawActions = () =>
		panel.setActions(tasks.some((task) => ENDED.has(task.status)) && h("button", { type: "button", text: t("bgClear"), onclick: () => act({ type: "bg_clear" }) }));

	// Refreshed while open: the states, and the chosen task's output while it runs.
	const timer = setInterval(async () => {
		if (!panel.el.isConnected) return;
		const fresh = await view.engine.request({ type: "bg_list" }).catch(() => undefined);
		if (!fresh) return;
		const changed = JSON.stringify(fresh.tasks.map((task) => [task.id, task.status])) !== JSON.stringify(tasks.map((task) => [task.id, task.status]));
		tasks = fresh.tasks;
		const task = tasks.find((entry) => entry.id === chosen);
		if (changed) {
			drawList();
			drawActions();
			await drawDetail();
		} else if (task && !ENDED.has(task.status)) {
			for (const meta of list.querySelectorAll("li[data-id]")) {
				const entry = tasks.find((other) => other.id === meta.dataset.id);
				const text = meta.querySelector(".bg-meta");
				if (entry && text) text.textContent = `${entry.id} · ${entry.statusLabel} · ${ago(entry)}`;
			}
			await refreshOutput();
		}
	}, REFRESH_MS);

	panel.setBody(h("div", { class: "bg-layout" }, list, detail));
	drawList();
	drawActions();
	await drawDetail();
	try {
		await view.showPanel("bg", panel);
	} finally {
		clearInterval(timer);
	}
}
