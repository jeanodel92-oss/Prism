/**
 * fork: where the context's tokens go, for the window's /context screen (rpc-inspect.ts).
 *
 * The estimate is the one the terminal's /context shows: `buildTokenBreakdown` and its helpers are copied from
 * the vendored pi-context-inspector 1.3.0 (vendor/forks/pi-context-inspector/src/index.ts, MIT,
 * © 2026 Yuri Teixeira, YuGiMob, Agnish Chakraborty). That package is a replaceable extension and is copied
 * unchanged, so the engine cannot import its internals. Each part is
 * estimated from its characters, then scaled so the parts add up to the provider's measured total.
 *
 * the parts are those of the context the model receives, and the
 * buffer is the room above where auto-compaction starts with the session's settings.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULT_COMPACTION_SETTINGS, estimateTokens } from "../core/compaction/compaction.ts";
import type { ContextUsage } from "../core/extensions/types.ts";

export interface ContextBreakdown {
	total: number;
	contextWindow: number;
	percent: number;
	reserveTokens: number;
	safeAvailable: number;
	systemPrompt: number;
	systemTools: number;
	tools: number;
	skills: number;
	messages: number;
	other: number;
}

type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments?: Record<string, unknown> };

function isSkillPath(path: unknown): boolean {
	if (typeof path !== "string") return false;
	return /(^|\/)\.agents\/skills\/|(^|\/)\.pi\/agent\/.*\/skills\/|(^|\/)skills\/[^/]+\/SKILL\.md$/i.test(path);
}

const isSkillRead = (block: ToolCallBlock) => block.name === "read" && isSkillPath(block.arguments?.path);

const ESTIMATED_IMAGE_CHARS = 4800;

/**
 * `messages` is the session's context as the model receives it (buildSessionContext): what compaction summarised or a
 * context edit removed is not counted. `threshold` is where auto-compaction starts, in tokens; null when it is off,
 * undefined when unknown (the default reserve is shown then).
 */
export function buildTokenBreakdown(
	systemPrompt: string,
	activeToolDefs: unknown[],
	messages: readonly AgentMessage[],
	usage: ContextUsage | undefined,
	threshold: number | null | undefined,
): ContextBreakdown | undefined {
	if (usage?.tokens == null || !usage.contextWindow) return undefined;
	const estimateChars = (text: string) => Math.ceil(text.length / 4);
	const window = usage.contextWindow;
	const reserveTokens =
		threshold === null
			? 0
			: threshold === undefined
				? Math.min(DEFAULT_COMPACTION_SETTINGS.reserveTokens, window)
				: Math.min(window, Math.max(0, window - threshold));
	const systemRaw = estimateChars(systemPrompt);
	const toolDefsRaw = estimateChars(JSON.stringify(activeToolDefs));

	let messagesRaw = 0;
	let toolsRaw = 0;
	let skillsRaw = 0;
	const skillCalls = new Set<string>();
	for (const message of messages) {
		if (message.role === "branchSummary" || message.role === "compactionSummary") {
			messagesRaw += estimateChars(message.summary);
		} else {
			const weights = { messages: 0, tools: 0, skills: 0 };
			if (message.role === "user" || message.role === "custom") {
				if (typeof message.content === "string") weights.messages += estimateChars(message.content);
				else
					for (const block of message.content) {
						if (block.type === "text") weights.messages += estimateChars(block.text);
						else if (block.type === "image") weights.messages += ESTIMATED_IMAGE_CHARS;
					}
			} else if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "text") weights.messages += estimateChars(block.text);
					else if (block.type === "thinking") weights.messages += estimateChars(block.thinking);
					else if (block.type === "toolCall") {
						if (isSkillRead(block)) {
							weights.skills += estimateChars(JSON.stringify(block));
							skillCalls.add(block.id);
						} else weights.tools += estimateChars(JSON.stringify(block));
					}
				}
			} else if (message.role === "toolResult") {
				const skill = skillCalls.has(message.toolCallId);
				for (const block of message.content)
					if (block.type === "text") {
						if (skill) weights.skills += estimateChars(block.text);
						else weights.tools += estimateChars(block.text);
					}
			} else if (message.role === "bashExecution") {
				weights.tools += estimateChars(message.command) + estimateChars(message.output);
			}
			const sum = weights.messages + weights.tools + weights.skills;
			if (sum > 0) {
				const scale = estimateTokens(message) / sum;
				messagesRaw += weights.messages * scale;
				toolsRaw += weights.tools * scale;
				skillsRaw += weights.skills * scale;
			}
		}
	}

	const totalRaw = systemRaw + skillsRaw + toolDefsRaw + messagesRaw + toolsRaw;
	const ratio = totalRaw > 0 ? usage.tokens / totalRaw : 1;
	const exact = {
		systemPrompt: systemRaw * ratio,
		systemTools: toolDefsRaw * ratio,
		tools: toolsRaw * ratio,
		skills: skillsRaw * ratio,
		messages: messagesRaw * ratio,
	};
	const keys = Object.keys(exact) as (keyof typeof exact)[];
	const allocated = { systemPrompt: 0, systemTools: 0, tools: 0, skills: 0, messages: 0 };
	let remainder = usage.tokens;
	for (const key of keys) {
		allocated[key] = Math.floor(exact[key]);
		remainder -= allocated[key];
	}
	// The tokens lost to rounding go to the parts with the largest fractions, so the parts add up to the total.
	if (totalRaw > 0)
		for (const key of [...keys].sort((a, b) => (exact[b] % 1) - (exact[a] % 1))) {
			if (remainder <= 0) break;
			allocated[key] += 1;
			remainder -= 1;
		}
	const used = keys.reduce((sum, key) => sum + allocated[key], 0);
	return {
		total: usage.tokens,
		contextWindow: usage.contextWindow,
		percent: usage.percent ?? (usage.tokens / usage.contextWindow) * 100,
		reserveTokens,
		safeAvailable: Math.max(0, usage.contextWindow - reserveTokens - usage.tokens),
		...allocated,
		other: Math.max(0, usage.tokens - used),
	};
}
