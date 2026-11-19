// Test-only scripted provider: replays a fixed conversation so the TUI can be
// rendered and captured without a real model. Never installed.
// Prompts: "slow" (long thinking), "bench" (long markdown, ~1-token deltas),
// "md" (markdown only), "mermaid" (a diagram), "wall" (a long paragraph of W), "longthink" (reasoning with a
// long unbroken line), anything else (thinking, text and tool calls).
// "call <tool> <json>" and "calls [[tool, json], ...]": tool calls in one turn, then "ok".
// "steps [[tool, json], ...]": one call per turn, in order, then "ok".
// With FAKE_HANG_TOOL=1, also registers "hang", a tool that never settles and ignores aborts.
// With FAKE_KEY_DIGEST=<file>, appends the SHA-256 of each request's API key to that file.
// With FAKE_PLAIN=1, any other prompt (a background task's end, say) gets "ok" instead of the demo script.
// "attachments?": the image types and files the message carried; FAKE_VISION=1 declares the model as taking images.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { type AssistantMessage, createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// fork/tools/bench.sh: when each response starts and ends, so the bench probe can tell the
// harness's own time from the time spent waiting for this provider.
const benchGlobal = globalThis as { __prismBenchProviderSpans?: Array<[number, number]> };
const providerSpans = (benchGlobal.__prismBenchProviderSpans ??= []);

type Block =
	| { kind: "thinking"; text: string }
	| { kind: "text"; text: string; chunk?: number }
	| { kind: "tool"; name: string; args: Record<string, unknown>; partials?: Record<string, unknown>[] };

const FINAL = `## Résumé

Le pack visuel est en place. Points clés :

- **Thème** \`prism\` — palette *spectrale* violet → bleu → aqua
- Composer façon opencode, avec barre d'accent
- Statusline segmentée, jauge de contexte en dégradé

1. Premier point numéroté
2. Second point avec \`code inline\`

\`\`\`ts
export function hello(name: string): string {
  // salut
  return \`hi \${name}\`;
}
\`\`\`

> Une citation pour vérifier le rendu des blockquotes.

| Surface | Avant | Après |
|---|---|---|
| Footer | 2 lignes grises | statusline |
| Tools | boîtes pleines | timeline |

---

Voir [la doc](https://pi.dev) pour le reste.`;

const BENCH = Array.from({ length: 5 }, (_, i) => `### Partie ${i + 1}\n\n${FINAL}`).join("\n\n");

function script(
	prompt: string,
	turn: number,
	tools: string[],
	images: string[] = [],
): { blocks: Block[]; stop: "stop" | "toolUse"; delay: number } {
	// "tools?": the names of the tools sent with the request.
	if (prompt.trim() === "tools?") return { blocks: [{ kind: "text", text: `tools: ${tools.join(", ")}` }], stop: "stop", delay: 4 };
	// "attachments?": the images and files the message carried, as the model received them.
	if (prompt.trim().startsWith("attachments?")) {
		const files = [...prompt.matchAll(/<file name="([^"]*)">\n?([^\n]*)/g)].map((m) => `${m[1]!.split("/").pop()}: ${m[2]}`);
		const text = `images: ${images.join(", ") || "none"}; files: ${files.join("; ") || "none"}`;
		return { blocks: [{ kind: "text", text }], stop: "stop", delay: 4 };
	}
	// "call <tool> <json args>": one call to any tool, then "ok" (smoke tests of extension tools).
	const call = /^call (\S+) (\{.*\})$/s.exec(prompt.trim());
	if (call) {
		if (turn > 0) return { blocks: [{ kind: "text", text: "ok" }], stop: "stop", delay: 4 };
		return { blocks: [{ kind: "tool", name: call[1]!, args: JSON.parse(call[2]!) }], stop: "toolUse", delay: 4 };
	}
	// "stream-call <tool> <json args>": as "call", its arguments streamed one entry of `blocks` at a time
	// (the generated UI's preview while the model writes it).
	const streamed = /^stream-call (\S+) (\{.*\})$/s.exec(prompt.trim());
	if (streamed) {
		if (turn > 0) return { blocks: [{ kind: "text", text: "ok" }], stop: "stop", delay: 4 };
		const args = JSON.parse(streamed[2]!) as Record<string, unknown>;
		const parts = Array.isArray(args.blocks) ? args.blocks : [];
		const partials = parts.map((_, k) => ({ ...args, blocks: parts.slice(0, k + 1) }));
		return { blocks: [{ kind: "tool", name: streamed[1]!, args, partials }], stop: "toolUse", delay: 150 };
	}
	// "steps [[tool, args], ...]": one call per turn, so each waits for the one before.
	const steps = /^steps (\[.*\])$/s.exec(prompt.trim());
	if (steps) {
		const list = JSON.parse(steps[1]!) as Array<[string, Record<string, unknown>]>;
		const step = list[turn];
		if (!step) return { blocks: [{ kind: "text", text: "ok" }], stop: "stop", delay: 4 };
		return { blocks: [{ kind: "tool", name: step[0], args: step[1] }], stop: "toolUse", delay: 4 };
	}
	// "calls [[tool, args], ...]": parallel calls in one turn, then "ok".
	const calls = /^calls (\[.*\])$/s.exec(prompt.trim());
	if (calls) {
		if (turn > 0) return { blocks: [{ kind: "text", text: "ok" }], stop: "stop", delay: 4 };
		const list = JSON.parse(calls[1]!) as Array<[string, Record<string, unknown>]>;
		return { blocks: list.map(([name, args]) => ({ kind: "tool", name, args })), stop: "toolUse", delay: 4 };
	}
	if (process.env.FAKE_PLAIN === "1") return { blocks: [{ kind: "text", text: "ok" }], stop: "stop", delay: 4 };
	if (prompt.includes("slow")) {
		return {
			blocks: [
				{ kind: "thinking", text: "Je réfléchis longuement à la question posée, en pesant plusieurs options possibles avant de répondre. ".repeat(6) },
				{ kind: "text", text: "Réponse lente terminée." },
			],
			stop: "stop",
			delay: 260,
		};
	}
	// Long markdown stream in ~1-token deltas, for fork/tools/bench.sh.
	if (prompt.includes("bench")) return { blocks: [{ kind: "text", text: BENCH, chunk: 4 }], stop: "stop", delay: 8 };
	// A Mermaid diagram between two paragraphs, streamed, for the window's diagrams (Settings › Mermaid diagrams).
	if (prompt.includes("mermaid")) return { blocks: [{ kind: "text", text: MERMAID, chunk: 8 }], stop: "stop", delay: 40 };
	// One long paragraph of W, streamed, for the transcript's scroll while a reply grows.
	if (prompt.includes("wall")) return { blocks: [{ kind: "text", text: "W".repeat(16000), chunk: 12 }], stop: "stop", delay: 6 };
	// Reasoning with one long unbroken line, for the window's horizontal overflow.
	if (prompt.includes("longthink"))
		return {
			blocks: [
				{
					kind: "thinking",
					text: `The page loads: <link href="https://fonts.googleapis.com/css2?${"family=Inter:wght@400;500;600;700&".repeat(8)}display=swap" rel="stylesheet" />`,
				},
				{ kind: "text", text: "ok" },
			],
			stop: "stop",
			delay: 4,
		};
	if (prompt.includes("md")) return { blocks: [{ kind: "text", text: FINAL }], stop: "stop", delay: 4 };
	if (turn === 0) {
		return {
			blocks: [
				{
					kind: "thinking",
					text: "The user wants a tour. I should read the config first, then list the directory.\n\nLet me also grep for TODOs.",
				},
				{ kind: "text", text: "Je commence par regarder la config et l'arborescence." },
				{ kind: "tool", name: "read", args: { path: "sample.ts" } },
				{ kind: "tool", name: "bash", args: { command: "ls -la && echo done" } },
				{ kind: "tool", name: "grep", args: { pattern: "TODO", path: "." } },
			],
			stop: "toolUse",
			delay: 12,
		};
	}
	if (turn === 1) {
		return {
			blocks: [
				{ kind: "text", text: "Je corrige la fonction et j'ajoute un fichier." },
				{
					kind: "tool",
					name: "edit",
					args: {
						path: "sample.ts",
						edits: [{ oldText: "return a + b; // TODO overflow", newText: "const sum = a + b;\n  return Number.isFinite(sum) ? sum : 0;" }],
					},
				},
				{ kind: "tool", name: "write", args: { path: "notes.md", content: "# Notes\n\n- one\n- two\n" } },
				{ kind: "tool", name: "read", args: { path: "missing-file.txt" } },
				{ kind: "tool", name: "find", args: { pattern: "*.ts" } },
			],
			stop: "toolUse",
			delay: 12,
		};
	}
	return { blocks: [{ kind: "text", text: FINAL }], stop: "stop", delay: 4 };
}

const MERMAID = [
	"Voici le flux :",
	"",
	"```mermaid",
	"flowchart LR",
	"  A[Question] --> B{Outils ?}",
	"  B -->|oui| C[Appel d'outil]",
	"  B -->|non| D[Réponse]",
	"  C --> D",
	"```",
	"",
	"Fin du schéma, puis une dernière phrase assez longue pour que le flux continue un moment après le bloc.",
].join("\n");

function chunks(text: string, size = 6): string[] {
	const out: string[] = [];
	for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
	return out;
}

export default function (pi: ExtensionAPI) {
	if (process.env.FAKE_HANG_TOOL === "1") {
		pi.registerTool({
			name: "hang",
			label: "Hang",
			description: "Test tool: never returns and ignores aborts.",
			parameters: Type.Object({}),
			execute: () => new Promise<never>(() => {}),
		});
	}
	pi.registerProvider("fake", {
		baseUrl: "http://127.0.0.1:9",
		apiKey: "fake-key",
		api: "fake-scripted",
		models: [
			{
				id: "scripted",
				name: "Scripted",
				reasoning: true,
				// FAKE_VISION=1: a model that takes images.
				input: process.env.FAKE_VISION === "1" ? ["text", "image"] : ["text"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
				contextWindow: 200000,
				maxTokens: 8000,
			},
		],
		streamSimple(model: any, context: any, options: any) {
			const stream = createAssistantMessageEventStream();
			if (process.env.FAKE_KEY_DIGEST)
				appendFileSync(
					process.env.FAKE_KEY_DIGEST,
					`${createHash("sha256").update(String(options?.apiKey ?? "")).digest("hex")}\n`,
				);
			const msgs: any[] = context.messages ?? [];
			let lastUser = -1;
			for (let i = msgs.length - 1; i >= 0; i--) {
				if (msgs[i].role === "user") {
					lastUser = i;
					break;
				}
			}
			const u = msgs[lastUser];
			const prompt = typeof u?.content === "string" ? u.content : (u?.content ?? []).map((c: any) => c.text ?? "").join(" ");
			const turn = msgs.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
			const tools = [...(context.tools ?? []), ...getCurrentTools(msgs)].map((tool: any) => String(tool.name));
			const images = (Array.isArray(u?.content) ? u.content : []).filter((c: any) => c.type === "image").map((c: any) => String(c.mimeType));
			const { blocks, stop, delay } = script(prompt, turn, tools, images);
			const startedAt = performance.now();
			(async () => {
				const output: AssistantMessage = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1200 + turn * 800,
						output: 0,
						cacheRead: 4000 * turn,
						cacheWrite: 300,
						totalTokens: 0,
						cost: { input: 0.0036, output: 0, cacheRead: 0.0012 * turn, cacheWrite: 0.0009, total: 0 },
					},
					stopReason: "pending",
					timestamp: Date.now(),
				} as AssistantMessage;
				stream.push({ type: "start", partial: output } as any);
				let n = 0;
				for (const b of blocks) {
					if (options?.signal?.aborted) break;
					const idx = output.content.length;
					if (b.kind === "thinking") {
						output.content.push({ type: "thinking", thinking: "" } as any);
						stream.push({ type: "thinking_start", contentIndex: idx, partial: output } as any);
						for (const c of chunks(b.text)) {
							// A real provider stops on the abort; checking only between blocks made a stop
							// during "slow" take ~25 s, which test timeouts hid.
							if (options?.signal?.aborted) break;
							(output.content[idx] as any).thinking += c;
							stream.push({ type: "thinking_delta", contentIndex: idx, delta: c, partial: output } as any);
							await sleep(delay);
						}
						stream.push({ type: "thinking_end", contentIndex: idx, content: b.text, partial: output } as any);
					} else if (b.kind === "text") {
						output.content.push({ type: "text", text: "" } as any);
						stream.push({ type: "text_start", contentIndex: idx, partial: output } as any);
						for (const c of chunks(b.text, b.chunk ?? 12)) {
							if (options?.signal?.aborted) break;
							(output.content[idx] as any).text += c;
							stream.push({ type: "text_delta", contentIndex: idx, delta: c, partial: output } as any);
							await sleep(delay);
						}
						stream.push({ type: "text_end", contentIndex: idx, content: b.text, partial: output } as any);
					} else {
						const call = { type: "toolCall", id: `call_${turn}_${n++}`, name: b.name, arguments: b.args };
						output.content.push(call as any);
						stream.push({ type: "toolcall_start", contentIndex: idx, partial: output } as any);
						call.arguments = {};
						for (const partial of b.partials ?? [b.args]) {
							if (options?.signal?.aborted) break;
							call.arguments = partial;
							stream.push({ type: "toolcall_delta", contentIndex: idx, delta: JSON.stringify(partial), partial: output } as any);
							await sleep(delay * 4);
						}
						call.arguments = b.args;
						stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: call, partial: output } as any);
					}
				}
				output.usage.output = 350 + turn * 120;
				output.usage.cost.output = output.usage.output * 0.000015;
				output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead;
				output.usage.cost.total =
					output.usage.cost.input + output.usage.cost.output + output.usage.cost.cacheRead + output.usage.cost.cacheWrite;
				output.stopReason = options?.signal?.aborted ? "aborted" : stop;
				stream.push({ type: "done", reason: output.stopReason, message: output } as any);
				providerSpans.push([startedAt, performance.now()]);
				stream.end();
			})();
			return stream;
		},
	});
}
