/**
 * fork: what a session was doing when it stopped. On resume, a tool call left without a result
 * (the process died during the tool) is shown with what to do; `/state` shows the same view on demand.
 * pi already gives the model a synthetic result for such calls (`transform-messages.ts`), so only the display
 * is added here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Component, sanitizeTerminalLabel, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import type { SessionEntry } from "../core/session-manager.ts";
import { backgroundTasks } from "./background.ts";
import { checkpointDir } from "./checkpoints.ts";
import { fill, labelled, t } from "./i18n/index.ts";
import { hasNativeMenus } from "./interactive-client.ts";
import { redact } from "./request-inspector.ts";
import { knownSecrets } from "./secrets/env.ts";

const WIDGET = "session-state";

type InterruptedCall = { name: string; args: string; entryIndex: number };

function findInterruptedCalls(entries: SessionEntry[]): InterruptedCall[] {
	// fork: keyed by occurrence, since a later turn may reuse the id of a call
	// left without a result; a result answers the latest call of its id.
	const calls = new Map<string, { name: string; arguments: unknown; entryIndex: number }>();
	const latest = new Map<string, string>();
	for (const [entryIndex, entry] of entries.entries()) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant") {
			for (const block of entry.message.content) {
				if (block.type !== "toolCall") continue;
				const key = `${entryIndex}:${block.id}`;
				calls.set(key, { name: block.name, arguments: block.arguments, entryIndex });
				latest.set(block.id, key);
			}
		} else if (entry.message.role === "toolResult") {
			const key = latest.get(entry.message.toolCallId);
			if (key !== undefined) calls.delete(key);
			latest.delete(entry.message.toolCallId);
		}
	}
	// Only the calls left without a result are masked and shown: masking reads the stored keys, and doing it for every
	// call of a long session on each resume cost tens of MB (RAM pass, gui-fork10.md § 56).
	const secrets = calls.size > 0 ? knownSecrets() : undefined;
	return [...calls.values()].map(({ name, arguments: args, entryIndex }) => {
		const text = JSON.stringify(redact(args, "", secrets));
		return { name, args: text.length > 80 ? `${text.slice(0, 77)}…` : text, entryIndex };
	});
}

/** The turns `/undo` and `/checkpoints` can rewind, as "turn N". */
function getCheckpoints(dir: string | undefined): string[] {
	if (!dir) return [];
	try {
		const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as Array<{ turn: number }>;
		return [...new Set(index.map((item) => item.turn))].map((turn) => fill("turn {0}", String(turn)));
	} catch {
		return [];
	}
}

function lastTurnStatus(entries: SessionEntry[], calls: InterruptedCall[]): "interrupted" | "error" | "completed" {
	const lastUserIndex = entries.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user");
	if (calls.some((call) => call.entryIndex > lastUserIndex)) return "interrupted";
	// fork: only the reply to the last prompt counts, and the turn ended only on
	// a model reply that called no tool. A prompt still waiting for the model, or tools whose results came in before
	// the next reply, was cut short; the previous prompt's reply says nothing about it.
	const reply = entries
		.slice(lastUserIndex + 1)
		.findLast(
			(entry) =>
				entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult"),
		);
	if (reply?.type !== "message") return lastUserIndex === -1 ? "completed" : "interrupted";
	const message = reply.message;
	if (message.role !== "assistant") return "interrupted";
	if (message.stopReason === "error") return "error";
	return message.stopReason === "aborted" || message.stopReason === "toolUse" ? "interrupted" : "completed";
}

/** `running`: background tasks still running, or undefined when the background module is off. */
export function sessionStateData(entries: SessionEntry[], checkpoints: string[], running?: number) {
	const calls = findInterruptedCalls(entries);
	return { status: lastTurnStatus(entries, calls), calls, checkpoints, running };
}

export function sessionStateSnapshot(ctx: ExtensionContext) {
	return sessionStateData(
		ctx.sessionManager.getBranch(),
		getCheckpoints(checkpointDir(ctx.sessionManager)),
		backgroundTasks()?.filter((task) => task.status === "running").length,
	);
}

export type SessionStateData = ReturnType<typeof sessionStateData>;

/**
 * where an RPC engine sends the state, for a client that shows it natively (the Prism window);
 * `undefined` once it no longer applies.
 */
export interface SessionStateHost {
	show(state: SessionStateData | undefined): void;
}

let host: SessionStateHost | undefined;

export function setSessionStateHost(next: SessionStateHost | undefined): void {
	host = next;
}

export function formatSessionState(
	entries: SessionEntry[],
	checkpoints: string[],
	width: number,
	running?: number,
): string[] {
	const { calls, status } = sessionStateData(entries, checkpoints, running);
	const lines = [
		labelled("Last turn", t(status)),
		labelled("Interrupted tool calls", String(calls.length)),
		// fork: the name comes from the session file; the arguments are JSON already.
		...calls.map(
			(call) => `${sanitizeTerminalLabel(call.name)} ${call.args} — ${t("interrupted; no result recorded")}`,
		),
		labelled(
			"Running background tasks",
			running === undefined ? t("module off") : running ? `${running} (/bg)` : "0",
		),
		labelled("Available checkpoints", checkpoints.length ? checkpoints.join(", ") : t("none")),
		...(calls.length ? [t("Ask the model to re-run a tool, or use /undo if this turn has checkpoints.")] : []),
	];
	return lines
		.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)))
		.map((line) => truncateToWidth(line, width));
}

export default function sessionState(pi: ExtensionAPI) {
	const running = () => backgroundTasks()?.filter((task) => task.status === "running").length;
	let sent = false;
	const clearSent = () => {
		if (sent) host?.show(undefined);
		sent = false;
	};
	const show = (ctx: ExtensionContext, onlyIfInterrupted = false) => {
		const entries = ctx.sessionManager.getBranch();
		// On resume, only a session whose last turn was cut short: an old orphan call is history, left to /state.
		if (onlyIfInterrupted && lastTurnStatus(entries, findInterruptedCalls(entries)) !== "interrupted") {
			// Another session of the same engine (/new, /resume): the previous one's card no longer applies.
			clearSent();
			return;
		}
		const checkpoints = getCheckpoints(checkpointDir(ctx.sessionManager));
		// An RPC client gets the state itself, even before it says it shows native menus: a resumed session's
		// session_start comes first. The Prism window shows it as its own card, not as the widget's lines.
		if (ctx.mode === "rpc" && host) {
			host.show(sessionStateData(entries, checkpoints, running()));
			sent = true;
		}
		if (hasNativeMenus(ctx)) return;
		// A component, so the lines follow the terminal width when it changes.
		ctx.ui.setWidget(
			WIDGET,
			(): Component => ({
				render: (width) => formatSessionState(entries, checkpoints, width, running()),
				invalidate: () => {},
			}),
		);
	};

	pi.on("session_start", async (_event, ctx) => show(ctx, true));
	// The view describes the state before the next prompt; it goes away once the user moves on.
	pi.on("before_agent_start", async (_event, ctx) => {
		clearSent();
		ctx.ui.setWidget(WIDGET, undefined);
	});
	pi.registerCommand("state", {
		description: "Show the current session state",
		handler: async (_args, ctx) => show(ctx),
	});
}
