import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SystemMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../core/extensions/types.ts";

function childProcessCount(): number | undefined {
	try {
		const tasks = readdirSync(`/proc/${process.pid}/task`);
		const children = new Set<string>();
		for (const task of tasks) {
			for (const child of readFileSync(`/proc/${process.pid}/task/${task}/children`, "utf8").trim().split(/\s+/u)) {
				if (child) children.add(child);
			}
		}
		return children.size;
	} catch {
		return undefined;
	}
}

export default function moduleCostProbe(pi: ExtensionAPI): void {
	const outputPath = process.env.PRISM_MODULE_COST_OUT;
	if (!outputPath) return;
	pi.registerProvider("prism-module-cost", {
		baseUrl: "http://127.0.0.1:9",
		apiKey: "offline-probe",
		api: "prism-module-cost",
		models: [
			{
				id: "probe",
				name: "Prism module cost probe",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 10,
			},
		],
		streamSimple(model: Model<Api>, context: TranscriptContext) {
			const systemMessages = context.messages
				.filter((message): message is SystemMessage => message.role === "system")
				.map((message) => ({
					content:
						typeof message.content === "string"
							? message.content
							: message.content.map((block) => block.text).join(""),
					sections: message.sections ?? {},
					toolsAdded: (message.toolsAdded ?? []).map((tool) => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					})),
					toolsRemoved: (message.toolsRemoved ?? []).map((tool) => tool.name),
				}));
			writeFileSync(
				outputPath,
				JSON.stringify({
					systemMessages,
					rss: process.memoryUsage().rss,
					startupMs: process.uptime() * 1000,
					children: childProcessCount(),
				}),
			);
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
