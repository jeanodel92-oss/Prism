/**
 * the thinking level of a model is the last one used with it. Each prompt sent
 * keeps the level in effect as that model's own (`modelThinkingLevels` in settings.json, the per-model level the
 * session already applies when it switches to a model and when a new session starts). Choosing a level in the window
 * or the terminal therefore sticks to the model, without saving it as a global default. Plan mode sets a level of its
 * own while it is on: that one is not kept.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { planBridge } from "./plan-bridge.ts";

export interface ThinkingMemory {
	getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined;
	setModelThinkingLevel(provider: string, modelId: string, level: ThinkingLevel): void;
}

export function rememberModelThinking(
	model: Model<any> | undefined,
	level: ThinkingLevel,
	settings: ThinkingMemory,
): void {
	if (!model?.reasoning || planBridge()?.enabled?.()) return;
	if (settings.getModelThinkingLevel(model.provider, model.id) === level) return;
	try {
		settings.setModelThinkingLevel(model.provider, model.id, level);
	} catch {
		// Not kept: the prompt goes on.
	}
}
