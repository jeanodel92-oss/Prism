// fork: a low-level loop whose own steps fail (a rejected prepareRequest,
// transformContext or listener) ends its stream as Agent ends such a run, instead of leaving it open.
import type { EventStream, Model } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentMessage } from "../types.ts";

/** Ends `stream` with an assistant message carrying `error`, and the events of a turn that ended with it. */
export function endFailedRun(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	model: Model<any>,
	error: unknown,
	aborted: boolean,
): void {
	const failure = {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	} satisfies AgentMessage;
	stream.push({ type: "message_start", message: failure });
	stream.push({ type: "message_end", message: failure });
	stream.push({ type: "turn_end", message: failure, toolResults: [] });
	stream.push({ type: "agent_end", messages: [failure] });
	stream.end([failure]);
}
