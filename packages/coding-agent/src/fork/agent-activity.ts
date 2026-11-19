/**
 * fork.10.5 ("une interface complète sur TUI et GUI pour voir ce que les subagents foutent"):
 * what a custom agent does while it runs, read from the events of its Prism process (agents.ts): each tool it calls,
 * on what, whether it worked, and what it says between its calls. The agent tool sends these steps with each update
 * and keeps them in its result, so the terminal's card and the window's card show them live and afterwards.
 */

/** One thing the agent did: a tool call, or what it said before calling tools. */
export interface AgentStep {
	/** The tool call's id, to mark its end. */
	id?: string;
	tool?: string;
	/** What the call works on: a command, a path, a pattern. */
	target?: string;
	status?: "running" | "done" | "error";
	text?: string;
}

/** At most this many steps are kept, the newest; the count of the others is said. */
export const MAX_AGENT_STEPS = 200;
const TARGET_CHARS = 120;
const TEXT_CHARS = 200;

const oneLine = (text: string, max: number) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** What a call works on, from its arguments: the command, the path or the pattern. */
export function stepTarget(tool: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	const pick = (...keys: string[]) => keys.map((key) => record[key]).find((value) => typeof value === "string");
	const value =
		tool === "bash"
			? pick("command")
			: tool === "grep" || tool === "find"
				? [pick("pattern"), pick("path")].filter(Boolean).join(" in ")
				: (pick("path", "file_path", "url", "query", "command", "pattern") ??
					Object.values(record).find((entry) => typeof entry === "string"));
	return typeof value === "string" ? oneLine(value, TARGET_CHARS) : "";
}

export class AgentActivity {
	readonly steps: AgentStep[] = [];
	/** Steps dropped to keep the newest. */
	dropped = 0;

	private push(step: AgentStep): void {
		this.steps.push(step);
		if (this.steps.length > MAX_AGENT_STEPS) {
			this.steps.shift();
			this.dropped++;
		}
	}

	/** Reads one event of the agent's process; true when the steps changed. */
	record(record: Record<string, unknown>): boolean {
		if (record.type === "tool_execution_start" && typeof record.toolName === "string") {
			this.push({
				id: typeof record.toolCallId === "string" ? record.toolCallId : undefined,
				tool: record.toolName,
				target: stepTarget(record.toolName, record.args),
				status: "running",
			});
			return true;
		}
		if (record.type === "tool_execution_end" && typeof record.toolCallId === "string") {
			const step = this.steps.findLast((candidate) => candidate.id === record.toolCallId);
			if (!step) return false;
			step.status = record.isError === true ? "error" : "done";
			return true;
		}
		if (record.type === "message_end" && record.message && typeof record.message === "object") {
			const message = record.message as { role?: unknown; content?: unknown; stopReason?: unknown };
			// What it says before calling tools; its final answer is the tool's result.
			if (message.role !== "assistant" || message.stopReason !== "toolUse" || !Array.isArray(message.content))
				return false;
			const text = message.content
				.flatMap((part) =>
					part && typeof part === "object" && part.type === "text" && typeof part.text === "string"
						? [part.text]
						: [],
				)
				.join(" ");
			if (!text.trim()) return false;
			this.push({ text: oneLine(text, TEXT_CHARS) });
			return true;
		}
		return false;
	}

	/** A copy for a tool update: later changes do not alter what was sent. */
	snapshot(): { steps: AgentStep[]; dropped: number } {
		return { steps: this.steps.map((step) => ({ ...step })), dropped: this.dropped };
	}
}

const MARK = { running: "…", done: "✓", error: "✗" } as const;

/** One line per step, as the terminal and the window show them. */
export function stepLine(step: AgentStep): string {
	if (step.text !== undefined) return `  “${step.text}”`;
	return [MARK[step.status ?? "running"], step.tool, step.target].filter(Boolean).join(" ");
}
