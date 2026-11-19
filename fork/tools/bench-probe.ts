// Test-only measurement probe for fork/tools/bench.sh. Never installed.
//
// Wraps the TUI frame (doRender of both screen modes) and the streaming update of
// the assistant message (AssistantMessageComponent.updateContent), then writes a
// JSON record to $PRISM_BENCH_OUT:
//   startup: first frame (ms since process start) and RSS once idle;
//   stream:  per-frame and per-delta costs while an assistant message streams;
//   input: for the first $PRISM_BENCH_KEYS keys after startup, the time from the key's
//            arrival on stdin to the end of the frame that follows;
//   turns: per prompt, wall time from submission to the end of the agent run, the time
//            waiting for the fake provider (fork/tools/fake-provider.ts records its spans) and for
//            tools, the rest being the harness's own time; and each tool's execution time.
import { writeFileSync } from "node:fs";
import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";

const outPath = process.env.PRISM_BENCH_OUT;
const idleMs = Number(process.env.PRISM_BENCH_IDLE_MS ?? 3000);

const record: Record<string, unknown> = {};
const write = () => {
	if (outPath) writeFileSync(outPath, JSON.stringify(record));
};

let firstFrameMs: number | undefined;
let streaming = false;
// Costs of the deltas received since the last frame.
let pendingDeltas = 0;
let pendingUpdateMs = 0;
const frameMs: number[] = [];
const updateMs: number[] = [];
// One entry per delta: (frame that displayed it + updates since the previous frame) / deltas in that frame.
const tokenMs: number[] = [];

const inputKeys = Number(process.env.PRISM_BENCH_KEYS ?? 0);
const inputLatencyMs: number[] = [];
let keysSeen = 0;
let keyAt: number | undefined;
// Listening from the first frame on: an early listener would read keys before the TUI does.
function listenToKeys(): void {
	if (inputKeys <= 0) return;
	process.stdin.prependListener("data", () => {
		if (keysSeen >= inputKeys) return;
		keysSeen++;
		keyAt ??= performance.now();
	});
}
function frameAfterKey(): void {
	if (keyAt === undefined) return;
	inputLatencyMs.push(performance.now() - keyAt);
	keyAt = undefined;
	if (inputLatencyMs.length === inputKeys) {
		record.input = { latencyMs: inputLatencyMs };
		write();
	}
}

const benchGlobal = globalThis as { __prismBenchProviderSpans?: Array<[number, number]> };
const providerSpans = (benchGlobal.__prismBenchProviderSpans ??= []);

/** Total length of the union of intervals, clipped to [from, to]. */
function covered(spans: Array<[number, number]>, from: number, to: number): number {
	const clipped = spans
		.map(([a, b]): [number, number] => [Math.max(a, from), Math.min(b, to)])
		.filter(([a, b]) => b > a)
		.sort((x, y) => x[0] - y[0]);
	let total = 0;
	let end = from;
	for (const [a, b] of clipped) {
		if (b <= end) continue;
		total += b - Math.max(a, end);
		end = b;
	}
	return total;
}

interface Turn {
	prompt: string;
	startedAt: number;
	tools: Map<string, { name: string; start: number; end?: number; error?: string }>;
}
let turn: Turn | undefined;
const turns: unknown[] = [];

function wrapRender(proto: { doRender(): void }): void {
	const original = proto.doRender;
	proto.doRender = function (this: unknown) {
		const start = performance.now();
		original.call(this);
		const ms = performance.now() - start;
		frameAfterKey();
		if (firstFrameMs === undefined) {
			firstFrameMs = process.uptime() * 1000;
			listenToKeys();
			setTimeout(() => {
				record.startup = { firstFrameMs, rssBytes: process.memoryUsage().rss };
				write();
			}, idleMs);
		}
		if (!streaming) return;
		frameMs.push(ms);
		if (pendingDeltas > 0) {
			const perDelta = (ms + pendingUpdateMs) / pendingDeltas;
			for (let i = 0; i < pendingDeltas; i++) tokenMs.push(perDelta);
			pendingDeltas = 0;
			pendingUpdateMs = 0;
		}
	};
}

// doRender is protected; the probe reaches it through the prototypes on purpose.
wrapRender(TuiMainScreen.prototype as unknown as { doRender(): void });
wrapRender(TuiAltScreen.prototype as unknown as { doRender(): void });

const originalUpdate = AssistantMessageComponent.prototype.updateContent;
AssistantMessageComponent.prototype.updateContent = function (
	this: AssistantMessageComponent,
	...args: Parameters<typeof originalUpdate>
) {
	const start = performance.now();
	originalUpdate.apply(this, args);
	if (!streaming) return;
	const ms = performance.now() - start;
	updateMs.push(ms);
	pendingDeltas++;
	pendingUpdateMs += ms;
};

export default function (pi: ExtensionAPI) {
	pi.on("input", (event) => {
		turn = { prompt: event.text.slice(0, 40), startedAt: performance.now(), tools: new Map() };
	});
	pi.on("tool_execution_start", (event) => {
		turn?.tools.set(event.toolCallId, { name: event.toolName, start: performance.now() });
	});
	pi.on("tool_execution_end", (event) => {
		const tool = turn?.tools.get(event.toolCallId);
		if (!tool) return;
		tool.end = performance.now();
		// A failed call is fast and measures nothing: the report must show it.
		if (event.isError) tool.error = JSON.stringify(event.result).slice(0, 200);
	});
	pi.on("agent_end", () => {
		if (!turn) return;
		const end = performance.now();
		const toolSpans = [...turn.tools.values()].flatMap((t): Array<[number, number]> =>
			t.end === undefined ? [] : [[t.start, t.end]],
		);
		const wallMs = end - turn.startedAt;
		const providerMs = covered(providerSpans, turn.startedAt, end);
		const toolMs = covered(toolSpans, turn.startedAt, end);
		const waitingMs = covered([...providerSpans, ...toolSpans], turn.startedAt, end);
		turns.push({
			prompt: turn.prompt,
			wallMs,
			providerMs,
			toolMs,
			harnessMs: wallMs - waitingMs,
			tools: [...turn.tools.values()].map((t) => ({
				name: t.name,
				ms: t.end === undefined ? null : t.end - t.start,
				...(t.error ? { error: t.error } : {}),
			})),
		});
		turn = undefined;
		record.turns = turns;
		write();
	});
	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") streaming = true;
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant" || !streaming) return;
		// Let the frame that shows the last deltas run before closing the record.
		setTimeout(() => {
			streaming = false;
			record.stream = { deltas: updateMs.length, frames: frameMs.length, frameMs, updateMs, tokenMs };
			write();
		}, 200);
	});
}
