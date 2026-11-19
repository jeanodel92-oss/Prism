/**
 * fork: the engine's technical log, which the Prism window and the phone show in their Logs
 * panel (the engine's stderr), said what failed and nothing else. It now also says what went well: each request to a
 * model and its answer, each reply with its tokens and time, each tool with its outcome, model changes, compactions.
 * Written only in RPC mode: in the terminal stderr is the screen, in print mode it is the user's output.
 * Never a tool's arguments or a message's text, which can hold anything; the window masks secrets in every line.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";

/** One line of the log, after its time of day. */
export function logLine(text: string, now = new Date()): string {
	const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
	return `${time} ${text}\n`;
}

/** "1.2 s" or "812 ms". */
export function duration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** What a finished reply says in the log: how it ended, its tokens and its time. */
export function replyLine(message: AssistantMessage, ms: number | undefined): string {
	const usage = message.usage;
	const tokens = [
		`${usage.input} tokens in`,
		...(usage.cacheRead > 0 ? [`${usage.cacheRead} read from cache`] : []),
		`${usage.output} out`,
		...(usage.reasoning ? [`${usage.reasoning} of them thinking`] : []),
	].join(", ");
	const model = `${message.provider}/${message.model}`;
	const served = message.responseModel && message.responseModel !== message.model ? ` (${message.responseModel})` : "";
	const time = ms === undefined ? "" : ` in ${duration(ms)}`;
	if (message.stopReason === "error")
		return `reply from ${model}${served} failed${time}: ${message.errorMessage ?? "error"}`;
	if (message.stopReason === "aborted") return `reply from ${model}${served} stopped${time}, ${tokens}`;
	return `reply from ${model}${served}: ${message.stopReason}${time}, ${tokens}`;
}

export default function engineLog(
	pi: ExtensionAPI,
	write: (text: string) => void = (text) => process.stderr.write(text),
): void {
	let mode: string | undefined;
	const log = (ctx: ExtensionContext, text: string) => {
		mode = ctx.mode;
		if (mode === "rpc") write(logLine(text));
	};
	const modelOf = (ctx: ExtensionContext) => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model");
	let requestStart: number | undefined;
	let replyStart: number | undefined;
	const tools = new Map<string, number>();

	pi.on("session_start", (event, ctx) => {
		log(ctx, `session ${event.reason}: ${modelOf(ctx)}, thinking ${pi.getThinkingLevel()}`);
	});
	pi.on("model_select", (event, ctx) => {
		log(ctx, `model set to ${event.model.provider}/${event.model.id} (${event.source})`);
	});
	pi.on("thinking_level_select", (event, ctx) => {
		log(ctx, `thinking set to ${event.level}`);
	});
	pi.on("agent_start", (_event, ctx) => log(ctx, "working"));
	pi.on("agent_end", (_event, ctx) => log(ctx, "idle"));
	pi.on("before_provider_request", (_event, ctx) => {
		requestStart = Date.now();
		replyStart ??= requestStart;
		log(ctx, `request sent to ${modelOf(ctx)}`);
	});
	pi.on("after_provider_response", (event, ctx) => {
		const after = requestStart === undefined ? "" : ` after ${duration(Date.now() - requestStart)}`;
		log(
			ctx,
			`${event.status < 400 ? "response" : "error response"} HTTP ${event.status} from ${modelOf(ctx)}${after}`,
		);
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		log(ctx, replyLine(event.message, replyStart === undefined ? undefined : Date.now() - replyStart));
		replyStart = undefined;
	});
	pi.on("tool_execution_start", (event, ctx) => {
		tools.set(event.toolCallId, Date.now());
		log(ctx, `tool ${event.toolName} started`);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const start = tools.get(event.toolCallId);
		tools.delete(event.toolCallId);
		const time = start === undefined ? "" : ` in ${duration(Date.now() - start)}`;
		log(ctx, `tool ${event.toolName} ${event.isError ? "failed" : "done"}${time}`);
	});
	pi.on("session_compact", (_event, ctx) => log(ctx, "context compacted"));
	pi.on("session_compact_failed", (event, ctx) =>
		log(ctx, event.aborted ? "compaction stopped" : `compaction failed: ${event.errorMessage ?? "error"}`),
	);
}
