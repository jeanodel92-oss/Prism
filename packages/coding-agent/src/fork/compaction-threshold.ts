/** fork: one trigger calculation for the engine and /settings. */
import { fill } from "./i18n/index.ts";

/** An invalid `compaction.thresholdPercent`: a bad value, not an unreadable settings file. */
export class CompactionThresholdError extends Error {}

export function validateCompactionThresholdPercent(value: unknown): asserts value is number | undefined {
	if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100)) {
		throw new CompactionThresholdError(
			`Invalid compaction.thresholdPercent setting: ${String(value)}. Expected a percentage above 0 and at most 100.`,
		);
	}
}

export function getCompactionThresholdTokens(
	contextWindow: number,
	reserveTokens: number,
	thresholdPercent?: number,
	maxTokens?: number,
): number {
	validateCompactionThresholdPercent(thresholdPercent);
	if (thresholdPercent === undefined) return contextWindow - reserveTokens;
	// 4k covers a small summary; 16k covers the default summary reply (~13k) plus its prompt.
	const replyLimit = maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 4096;
	const minReserve = Math.max(4096, Math.min(replyLimit, 16384));
	return Math.max(0, Math.min((contextWindow * thresholdPercent) / 100, contextWindow - minReserve));
}

export function lowThresholdWarning(
	contextWindow: number,
	reserveTokens: number,
	keepRecentTokens: number,
	thresholdPercent?: number,
	maxTokens?: number,
): string | undefined {
	if (thresholdPercent === undefined) return undefined;
	const thresholdTokens = getCompactionThresholdTokens(contextWindow, reserveTokens, thresholdPercent, maxTokens);
	if (thresholdTokens > keepRecentTokens) return undefined;
	const formatK = (tokens: number) => `${Number((tokens / 1000).toFixed(1))}k`;
	return fill(
		"Compaction would have nothing to summarize: it starts at {0} tokens and keeps the last {1} as they are. Raise the threshold percentage.",
		formatK(thresholdTokens),
		formatK(keepRecentTokens),
	);
}
