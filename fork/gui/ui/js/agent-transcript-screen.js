// A sub-agent's full transcript (fork.11, maintainer's plan of 2026-11-08: "subagents (quand y'en a, transcript complet)").
// The engine reads the agent's own session (agent_transcript): its task, replies, thinking and tool calls with their
// output, in order. A running agent's transcript is read again on demand; Stop ends it, after a second click.

import { Panel } from "./components.js";
import { clear, h } from "./dom.js";
import { t } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";

// A call's target on its line, as in the conversation's tool cards: its first text argument (a path, a command).
function target(args) {
	try {
		const value = Object.values(JSON.parse(args ?? "{}")).find((item) => typeof item === "string");
		if (value) return value.split("\n")[0];
	} catch {
		// Cut by the engine: the line shows none.
	}
	return "";
}

function entryNode(entry) {
	if (entry.kind === "user") return h("div", { class: "agent-entry user" }, h("p", { class: "panel-text", text: entry.text }));
	if (entry.kind === "assistant") return h("div", { class: "agent-entry assistant markdown" }, renderMarkdown(entry.text, { final: true }));
	if (entry.kind === "thinking")
		return h("details", { class: "check agent-entry thinking" }, h("summary", {}, h("span", { class: "check-name", text: t("agentThinking") })), h("pre", { class: "ctx-text", text: entry.text }));
	if (entry.kind === "tool")
		return h(
			"details",
			{ class: "check agent-entry tool", dataset: { state: entry.error ? "error" : entry.output === undefined ? "called" : "success" } },
			h("summary", {}, h("span", { class: "check-name", text: entry.name }), h("span", { class: "check-observed", text: target(entry.args) })),
			h("pre", { class: "ctx-text", text: entry.args }),
			entry.output !== undefined && h("pre", { class: "ctx-text agent-output", text: entry.output }),
		);
	return h("p", { class: "panel-text muted agent-entry note", text: entry.text });
}

/** `run`: a row of agents_get's `runs`. Resolves when the panel closes. */
export async function agentTranscriptScreen(view, run) {
	const panel = new Panel({ title: t("agentTranscriptTitle", run.agent, run.id), kind: "report agent-transcript" });
	const body = h("div", { class: "agent-transcript" });
	const load = async () => {
		const data = await view.engine.request({ type: "agent_transcript", session: run.session });
		clear(body);
		if (data.entries.length === 0) body.append(h("p", { class: "panel-text muted", text: t("agentTranscriptEmpty") }));
		for (const entry of data.entries) body.append(entryNode(entry));
	};
	await load();
	const actions = [];
	if (run.state === "running") {
		actions.push(
			h("button", {
				type: "button",
				dataset: { action: "refresh" },
				text: t("agentTranscriptRefresh"),
				onclick: () => load().catch((error) => view.app.toast(String(error?.message ?? error), "error")),
			}),
		);
		let sure = false;
		const stop = h("button", {
			type: "button",
			dataset: { action: "stop" },
			text: t("agentsStop"),
			onclick: async () => {
				if (!sure) {
					sure = true;
					stop.textContent = t("agentTranscriptStopSure");
					return;
				}
				stop.disabled = true;
				try {
					await view.engine.request({ type: "agents_stop", run: run.id });
					panel.done?.();
				} catch (error) {
					view.app.toast(String(error?.message ?? error), "error");
				}
			},
		});
		actions.push(stop);
	}
	panel.setBody(body);
	if (actions.length) panel.setActions(...actions);
	await view.showPanel("agent-transcript", panel);
}
