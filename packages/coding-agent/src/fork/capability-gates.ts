/**
 * fork: features follow what the model can do.
 *
 * - Absent (the server says no, or the user turned it off in /model-settings): the feature is off
 *   and the user is told. No tool calls: Prism replies without tools while the model is selected.
 *   No images: an attached image is not sent (pi already replaces it with a placeholder) and the
 *   user hears why. No thinking: pi already hides the thinking levels (`reasoning: false`).
 * - Unknown (the server does not say): the feature stays available; when the server then refuses a
 *   request that used it, a warning names it as a possible cause, marked as a hypothesis.
 * - Models detection never saw (added by hand, cloud providers) are left as they are.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, getModelsPath } from "../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import type { Tri } from "./capabilities.ts";
import { capabilitiesPath, readCapabilities, type StoredCapabilities } from "./capability-store.ts";
import { recordModelFailure } from "./doctor-diagnostics.ts";
import { t } from "./i18n/index.ts";
import { readModelCorrection } from "./model-settings.ts";
import { reloginNote } from "./oauth-relogin.ts";

export type Capability = "vision" | "tools" | "reasoning";

export interface Gate {
	state: Tri;
	/** "you" when the state comes from a correction in /model-settings. */
	source: "server" | "you";
}

export type Gates = Record<Capability, Gate>;

/** What the harness should assume, from detection and the user's corrections; undefined when never detected. */
export function effectiveGates(
	stored: StoredCapabilities | undefined,
	correction: Record<string, unknown>,
): Gates | undefined {
	if (!stored) return undefined;
	const you = (on: boolean): Gate => ({ state: on ? "yes" : "no", source: "you" });
	return {
		vision: Array.isArray(correction.input)
			? you(correction.input.includes("image"))
			: { state: stored.vision, source: "server" },
		tools: stored.toolCalls !== undefined ? you(stored.toolCalls) : { state: stored.tools, source: "server" },
		reasoning:
			typeof correction.reasoning === "boolean"
				? you(correction.reasoning)
				: { state: stored.reasoning, source: "server" },
	};
}

/** What the last request used, for naming a possible cause when the server refuses it. */
export interface RequestUse {
	images: boolean;
	tools: boolean;
	thinking: boolean;
}

/** Unknown capabilities the refused request relied on, in a fixed order. */
export function suspects(gates: Gates | undefined, use: RequestUse): Capability[] {
	if (!gates) return [];
	const used: Record<Capability, boolean> = { vision: use.images, tools: use.tools, reasoning: use.thinking };
	return (["vision", "tools", "reasoning"] as const).filter(
		(capability) => used[capability] && gates[capability].state === "unknown",
	);
}

const NAMES: Record<Capability, string> = { vision: "images", tools: "tool calls", reasoning: "thinking" };

/** The current model's gates, from detection and the user's corrections; undefined when never detected. */
export function gatesFor(model: Model<Api> | undefined): Gates | undefined {
	if (!model) return undefined;
	try {
		return effectiveGates(
			readCapabilities(capabilitiesPath(getAgentDir()), model.provider, model.id),
			readModelCorrection(getModelsPath(), model.provider, model.id),
		);
	} catch {
		return undefined;
	}
}

function hasImages(messages: readonly unknown[]): boolean {
	return messages.some((message) => {
		const content = (message as { content?: unknown }).content;
		return (
			Array.isArray(content) && content.some((part) => (part as { type?: unknown } | undefined)?.type === "image")
		);
	});
}

export default function capabilityGates(pi: ExtensionAPI) {
	/** The tools that were active before a model without tool calls turned them off. */
	let savedTools: string[] | undefined;
	let lastUse: RequestUse = { images: false, tools: false, thinking: false };

	const apply = (ctx: ExtensionContext, model: Model<Api> | undefined) => {
		const tools = gatesFor(model)?.tools;
		if (tools?.state === "no") {
			if (savedTools) return;
			savedTools = pi.getActiveTools();
			pi.setActiveTools([]);
			const why =
				tools.source === "you"
					? t("tool calls are turned off in /model-settings")
					: t("its server says it does not support tool calls");
			ctx.ui.notify(
				`${model!.id}: ${why}. ${t("Prism replies without tools (no reading, editing or commands) while this model is selected.")}`,
				"warning",
			);
		} else if (savedTools) {
			pi.setActiveTools(savedTools);
			savedTools = undefined;
		}
	};

	pi.on("session_start", (_event, ctx) => apply(ctx, ctx.model));
	pi.on("model_select", (event, ctx) => apply(ctx, event.model));
	// Other extensions may turn their tools on after the model was chosen (e.g. when a session starts):
	// before each run, set aside whatever is active again, so it comes back with the next model.
	pi.on("before_agent_start", (_event, ctx) => {
		if (!savedTools || gatesFor(ctx.model)?.tools.state !== "no") return;
		const active = pi.getActiveTools();
		if (active.length === 0) return;
		savedTools = [...new Set([...savedTools, ...active])];
		pi.setActiveTools([]);
	});

	pi.on("input", (event, ctx) => {
		if (!event.images?.length) return;
		const vision = gatesFor(ctx.model)?.vision;
		if (vision?.state !== "no") return;
		const why =
			vision.source === "you"
				? t("images are turned off for this model in /model-settings")
				: t("this model's server says it does not accept images");
		ctx.ui.notify(`${why}. ${t("The image is not sent; the model gets a note that it was left out.")}`, "warning");
	});

	pi.on("context", (event) => {
		lastUse = {
			images: hasImages(event.messages),
			tools: pi.getActiveTools().length > 0,
			thinking: pi.getThinkingLevel() !== "off",
		};
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
		if (message.role !== "assistant" || message.stopReason !== "error") return;
		recordModelFailure(message.errorMessage ?? t("Unknown model request error"));
		// a refused sign-in is fixed by /login, not by /doctor or a capability.
		const relogin = reloginNote([message.errorMessage ?? ""]);
		if (relogin) {
			ctx.ui.notify(relogin, "warning");
			return;
		}
		const names = suspects(gatesFor(ctx.model), lastUse).map((capability) => t(NAMES[capability]));
		if (names.length === 0) {
			ctx.ui.notify(t("Model request failed. Run /doctor for local diagnostics."), "warning");
			return;
		}
		ctx.ui.notify(
			t(
				`The server refused the request. Possible cause, not confirmed: this model may not support ${names.join(", ")} (its server does not say). /model-settings turns it off for this model.`,
			),
			"warning",
		);
	});
}
