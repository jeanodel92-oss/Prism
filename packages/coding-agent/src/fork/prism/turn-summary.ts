// fork: the end of each turn, a hairline carrying the turn's figures in ink 3: duration, tool calls, failures, tokens sent and received, cost. It also
// separates the turns when scrolling back. Kept as a custom session entry, which never reaches the model, so a
// resumed session shows it too. The words follow the interface mode and language when drawn, like the footer.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { t } from "../i18n/index.ts";
import { formatTokens } from "./footer.ts";
import { paint, tok } from "./lib/palette.ts";
import type { PrismState } from "./lib/state.ts";

export const TURN_ENTRY = "prism-turn";

export interface TurnFigures {
	ms: number;
	tools: number;
	failed: number;
	input: number;
	output: number;
	cost: number;
}

/** What one agent run did, from the messages it added. */
export function turnFigures(messages: readonly AgentMessage[], ms: number): TurnFigures {
	const figures: TurnFigures = { ms, tools: 0, failed: 0, input: 0, output: 0, cost: 0 };
	for (const message of messages) {
		if (message.role === "toolResult") {
			figures.tools++;
			if (message.isError) figures.failed++;
		} else if (message.role === "assistant" && message.usage) {
			// Sent tokens as the footer counts them: without the cache.
			figures.input += message.usage.input;
			figures.output += message.usage.output;
			figures.cost += message.usage.cost?.total ?? 0;
		}
	}
	return figures;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
	return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${Math.floor(minutes / 60)} h`;
}

/** The figures as words, in the interface language; the advanced interface uses the footer's arrows. */
export function turnParts(
	figures: TurnFigures,
	advanced: boolean,
): { main: string[]; tokens: string[]; cost: string[] } {
	const main = [formatDuration(figures.ms)];
	if (figures.tools) main.push(t(figures.tools === 1 ? "1 tool" : `${figures.tools} tools`));
	if (figures.failed) main.push(t(figures.failed === 1 ? "1 failure" : `${figures.failed} failures`));
	const tokens: string[] = [];
	if (figures.input || figures.output) {
		const sent = formatTokens(figures.input);
		const received = formatTokens(figures.output);
		if (advanced) tokens.push(`↑${sent} ↓${received}`);
		else tokens.push(t(`sent ${sent}`), t(`received ${received}`));
	}
	const cost = figures.cost > 0 ? [`$${figures.cost.toFixed(3)}`] : [];
	return { main, tokens, cost };
}

export function turnText(figures: TurnFigures, advanced: boolean): string {
	const { main, tokens, cost } = turnParts(figures, advanced);
	return [...main, ...tokens, ...cost].join(" · ");
}

/**
 * The line: two columns in, a short hairline, the figures, then the hairline to at most 82 columns. On a narrow
 * line the hairlines go first, then the token counts, which the footer also shows.
 */
export function turnLine(theme: Theme, figures: TurnFigures, advanced: boolean, width: number): string {
	const line = (n: number) => paint(tok(theme, "borderMuted"), "─".repeat(n));
	const ink3 = (text: string) => paint(tok(theme, "muted"), text);
	const room = Math.min(width, 82) - 2;
	const full = turnText(figures, advanced);
	if (visibleWidth(full) + 4 <= room) return `  ${line(2)} ${ink3(full)} ${line(room - visibleWidth(full) - 4)}`;
	if (visibleWidth(full) <= room) return `  ${ink3(full)}`;
	const { main, cost } = turnParts(figures, advanced);
	const short = [...main, ...cost].join(" · ");
	return `  ${ink3(truncateToWidth(short, Math.max(1, width - 2), "…"))}`;
}

export function installTurnSummary(pi: ExtensionAPI, state: PrismState): void {
	pi.registerEntryRenderer<TurnFigures>(TURN_ENTRY, (entry, _options, theme): Component | undefined => {
		const figures = entry.data;
		if (!figures) return undefined;
		return {
			render: (width) => [turnLine(theme, figures, state.interfaceMode() === "advanced", width)],
			invalidate: () => {},
		};
	});
	let started: number | undefined;
	pi.on("agent_start", async () => {
		started = Date.now();
	});
	pi.on("agent_end", async (event, ctx) => {
		if (!ctx.hasUI || started === undefined) return;
		pi.appendEntry<TurnFigures>(TURN_ENTRY, turnFigures(event.messages, Date.now() - started));
		started = undefined;
	});
}
