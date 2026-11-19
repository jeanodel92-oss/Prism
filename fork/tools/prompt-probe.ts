// Test-only provider for fork/tools/prompt-cost.sh. Never installed.
//
// Model "probe/dump" records what pi actually sends on the first request: the
// system messages (base content, named sections, tool definitions), then answers
// "ok". Writes JSON to $PRISM_PROMPT_OUT. It adds no tool and no prompt text.
import { writeFileSync } from "node:fs";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SystemMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("probe", {
		baseUrl: "http://127.0.0.1:9",
		apiKey: "probe-key",
		api: "prompt-probe",
		models: [
			{
				id: "dump",
				name: "Prompt probe",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 1000,
			},
		],
		streamSimple(model: Model<Api>, context: TranscriptContext) {
			const system = context.messages.filter((m): m is SystemMessage => m.role === "system");
			const outPath = process.env.PRISM_PROMPT_OUT;
			if (outPath) {
				writeFileSync(
					outPath,
					JSON.stringify({
						systemMessages: system.map((m) => ({
							content: m.content,
							sections: m.sections ?? {},
							toolsAdded: (m.toolsAdded ?? []).map((t) => ({
								name: t.name,
								description: t.description,
								parameters: t.parameters,
							})),
							toolsRemoved: m.toolsRemoved ?? [],
						})),
					}),
				);
			}
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
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
				stopReason: "stop",
				timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			});
			return stream;
		},
	});
}
