// The text of a module's message as the window shows it. The Plan module's message opens with an English title that
// the model reads too: only the shown copy is translated, the rest of the message is the plan as written.
import { t } from "./i18n.js";

/**
 * an agent's task, each tool it called on what and whether it worked, and what it
 * said between calls (agent-activity.ts sends the steps); its card and its answer message show them.
 */
export function agentStepLines({ task, steps = [], dropped }) {
	const mark = { running: "…", done: "✓", error: "✗" };
	return [
		...(task ? [`${t("agentTask")}: ${task}`] : []),
		...(dropped ? [t("agentEarlierSteps", dropped)] : []),
		...steps.map((step) => (step.text !== undefined ? `  “${step.text}”` : [mark[step.status ?? "running"], step.tool, step.target].filter(Boolean).join(" "))),
	];
}

/** How many tools an agent called, as its card and its answer message sum it up; "" without any. */
export function agentStepCount(steps = []) {
	const count = steps.filter((step) => step.tool).length;
	return count ? t(count === 1 ? "agentStep" : "agentSteps", count) : "";
}

const PLAN_TITLES = {
	"Proposed Plan": "planProposed",
	"Saved Plan": "planSaved",
	"Active Implementation Plan": "planActive",
};

export function customText(message, text) {
	// an agent's background task ended after its answer (agents.ts); the report stays as the model reads it.
	if (message.customType === "agent-background")
		return text.replace(/^\*\*Agent (.+?): background task ended\*\*/, (_match, name) => `**${t("agentBackgroundEnded", name)}**`);
	// an agent run in the background answered or failed (agents.ts).
	if (message.customType === "agent-answer") {
		// an answer agent_wait returned stays out of the model's message, in `details.answer`: shown here.
		const answer = message.details?.answer;
		return text
			// the line telling the model the user started this run is for the model only (agents.ts).
			.replace(/^(\*\*.+\*\*\n\n)\[Started by the user, not by you: [^\n]*\n\n/, "$1")
			.replace(/^\*\*Agent (.+?) (answered|failed|stopped) \((.+?)\)\*\*/, (_match, name, how, id) => `**${t({ failed: "agentFailed", stopped: "agentStopped" }[how] ?? "agentAnswered", name, id)}**`)
			.replace(/^(\*\*.+\*\*\n\n)The user stopped this agent before it answered\.$/, (_match, title) => `${title}${t("agentStoppedByUser")}`)
			.replace(/^(\*\*.+\*\*\n\n)Its answer was returned by agent_wait\.$/, (match, title) => (typeof answer === "string" ? `${title}${answer}` : match));
	}
	if (message.customType !== "proposed-plan") return text;
	return text.replace(
		/^\*\*(Proposed Plan|Saved Plan|Active Implementation Plan)\*\*/,
		(_match, title) => `**${t(PLAN_TITLES[title])}**`,
	);
}
