/**
 * Desktop notifications.
 *
 * Tells you when pi finished, and when it is stuck waiting for your approval —
 * so you can leave a long run unattended.
 *
 * Approval detection works without coupling to permissions.ts: this extension
 * loads first alphabetically, so its `tool_call` handler runs *before* the
 * permission gate prompts. It arms a timer for any call the gate is likely to
 * ask about, then cancels it once the tool actually starts executing. If the
 * timer survives, the call is sitting on a prompt.
 *
 * Anti-spam rules, in order of importance:
 *   - notifications are `normal` urgency + an expiry, so their popups
 *     auto-dismiss. `critical` is deliberately never used: most Linux daemons
 *     make critical notifications sticky, which is what turns a busy run into
 *     a wall of undismissable popups.
 *   - each notification replaces the previous one (`--replace-id` with the id
 *     the server gave it) instead of stacking.
 *   - approvals wait APPROVAL_DELAY_MS (long enough that you only see one if
 *     you actually stepped away) and are throttled globally.
 *   - pending approvals are collapsed into a single notification.
 *
 * Settings: /settings > Notifications (desktop notifications, approval notifications, a test notification).
 * no /notify command; the settings hold everything it did, in the
 * terminal and the Prism window alike.
 *
 * Registers no tools and no command.
 *
 * fork: copy of fork/reference/extensions/notify.ts, shipped as the built-in extension
 * `builtin:notify`. Its entry comes before `permissions` in `builtInExtensions`, so the `tool_call`
 * handler still runs before the built-in permission gate. Change from the reference: without `notify-send`, the
 * terminal escape fallback is written only when stdout is a terminal, so print, json and rpc
 * output on a pipe stays clean.
 *
 * fork: no `--transient`. With the server in do-not-disturb mode (SwayNotificationCenter), a
 * transient notification was neither shown nor kept in its list, so a test notification left no trace. The fixed
 * `--replace-id=919191` never matched an id the server had given, so it replaced nothing; the id the server
 * returns (`--print-id`) is used instead. The test notification says where it went, or why it failed.
 */

import { execFile } from "node:child_process";
import { sanitizeTerminalLabel } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../core/extensions/types.ts";
import { APP_DISPLAY_NAME } from "./brand.ts";
import { readGlobalSetting, saveGlobalSetting } from "./global-settings.ts";
import { hostCommand } from "./host-program.ts";
import { fill, t } from "./i18n/index.ts";
import { subscribePermissionDecision } from "./permissions.ts";
import { scheduledRun } from "./scheduled-tasks.ts";
import { sessionLifetime } from "./session-lifetime.ts";
import { type SettingsSection, setSettingsSection, settingsSections } from "./settings-sections.ts";

/** Minimum run time before a "finished" notification is worth sending. */
const MIN_RUN_MS = 20_000;
/** How long a gated call may sit before we assume you are away from the keyboard. */
const APPROVAL_DELAY_MS = 15_000;
/** Never send two approval notifications closer together than this. */
const APPROVAL_THROTTLE_MS = 90_000;
/** Auto-dismiss after this long. */
const EXPIRE_MS = 8_000;

/** Mirrors SAFE_BASH_COMMANDS in permissions.ts — commands the gate auto-allows. */
const SAFE_BASH = new Set([
	"ls",
	"ll",
	"dir",
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"wc",
	"file",
	"stat",
	"du",
	"df",
	"pwd",
	"which",
	"whereis",
	"echo",
	"printf",
	"date",
	"uname",
	"hostname",
	"whoami",
	"id",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"find",
	"tree",
	"sort",
	"uniq",
	"diff",
	"comm",
	"cut",
	"column",
	"jq",
	"yq",
	"md5sum",
	"sha1sum",
	"sha256sum",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"type",
	"man",
	"true",
	"cd",
]);

/** Read-only tools the gate auto-allows. */
const SAFE_TOOLS = new Set(["read", "grep", "find", "ls", "session_search"]);

/** What became of a notification: the id the server gave it, or why notify-send failed. */
type Delivery = { sent: true; id: string } | { sent: false; reason: string; terminal: boolean };

/** `last` holds the id of the previous notification, which the next one replaces. */
function send(last: { id?: string }, title: string, body: string, done?: (delivery: Delivery) => void) {
	body = t(body);
	// fork: never a `notify-send` the sandbox could write.
	execFile(
		hostCommand("notify-send"),
		[
			`--app-name=${APP_DISPLAY_NAME}`,
			"--urgency=normal",
			`--expire-time=${EXPIRE_MS}`,
			"--print-id",
			...(last.id ? [`--replace-id=${last.id}`] : []),
			"--icon=utilities-terminal",
			title,
			body,
		],
		(error, stdout, stderr) => {
			if (!error) {
				const id = String(stdout).trim();
				if (/^\d+$/.test(id)) last.id = id;
				done?.({ sent: true, id });
				return;
			}
			const reason =
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? t("notify-send is not installed")
					: String(stderr).trim() || error.message;
			const terminal = process.stdout.isTTY === true;
			done?.({ sent: false, reason, terminal });
			if (!terminal) return;
			// fork: the body carries a tool argument chosen by the model; a BEL
			// or ESC in it would end the sequence and write its own.
			title = sanitizeTerminalLabel(title);
			body = sanitizeTerminalLabel(body);
			if (process.env.KITTY_WINDOW_ID) {
				process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
				process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
			} else {
				process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
			}
		},
	);
}

/** fork: what the test notification tells, since notify-send exiting with 0 does not mean a pop-up. */
function deliveryReport(delivery: Delivery): { message: string; level: "info" | "warning" } {
	if (delivery.sent)
		return {
			message: fill(
				"Test notification sent to the desktop (id {0}). No pop-up? Your notification server may be in do-not-disturb mode: the notification is then in its list.",
				delivery.id,
			),
			level: "info",
		};
	const fallback = delivery.terminal ? ` ${t("The terminal's own notification was sent instead.")}` : "";
	return { message: `${fill("Desktop notification failed: {0}.", delivery.reason)}${fallback}`, level: "warning" };
}

/** Would the permission gate prompt for this call? Approximates ask-mode defaults. */
function likelyPrompts(toolName: string, input: unknown): boolean {
	if (SAFE_TOOLS.has(toolName)) return false;
	if (toolName !== "bash") return true;
	const command = (input as { command?: unknown })?.command;
	if (typeof command !== "string") return true;
	// Compound commands are gated as a whole; only a lone safe verb is auto-allowed.
	if (/[|;&><`$(]/.test(command)) return true;
	const verb = command.trim().split(/\s+/)[0];
	return !SAFE_BASH.has(verb);
}

function truncate(text: string, max: number) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** A short, meaningful label for a call — never just the tool name again. */
function describe(toolName: string, input: unknown): string {
	const record = (input ?? {}) as Record<string, unknown>;
	for (const key of ["command", "path", "query", "url"]) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return truncate(value, 70);
	}
	const urls = record.urls;
	if (typeof urls === "string") return truncate(urls, 70);
	if (Array.isArray(urls) && urls.length > 0) return truncate(String(urls[0]), 70);
	// Fall back to the first non-empty string argument, whatever it is called.
	for (const value of Object.values(record)) {
		if (typeof value === "string" && value.length > 0) return truncate(value, 70);
	}
	return toolName;
}

/**
 * fork: `desktopNotifications` in the global settings.json, set from /settings > Notifications.
 * Missing values are on, as before.
 */
function readNotifySettings(): { enabled: boolean; approvals: boolean } {
	const value = readGlobalSetting("desktopNotifications");
	const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	return { enabled: record.enabled !== false, approvals: record.approvals !== false };
}

const SETTINGS_OWNER = "notify";

/**
 * fork: whether the Prism window that runs this engine is in front, as it reports it
 * (`window_focus`, rpc-builtins.ts). While it is, the user sees the conversation: no desktop notification. The
 * terminal never reports it, so it keeps every notification; the phone app reports its own focus, the PC then stays
 * quiet while the phone shows the conversation.
 */
let clientFocused = false;

export function setClientFocused(focused: boolean): void {
	clientFocused = focused;
}

export default function (pi: ExtensionAPI) {
	const life = sessionLifetime(pi);
	let enabled = true;
	let approvalsEnabled = true;
	let settingsSection: SettingsSection | undefined;
	let runStartedAt: number | undefined;
	let lastApprovalNotice = 0;
	const last: { id?: string } = {};

	const pending = new Map<string, { timer: NodeJS.Timeout; label: string }>();

	function clearPending(toolCallId?: string) {
		if (toolCallId) {
			const entry = pending.get(toolCallId);
			if (entry) clearTimeout(entry.timer);
			pending.delete(toolCallId);
			return;
		}
		for (const entry of pending.values()) clearTimeout(entry.timer);
		pending.clear();
	}

	function announceApproval(label: string) {
		if (clientFocused) return;
		const now = Date.now();
		if (now - lastApprovalNotice < APPROVAL_THROTTLE_MS) return;
		lastApprovalNotice = now;
		// Collapse anything else still waiting into one line.
		// fork: the announced call has already left `pending`.
		const others = pending.size;
		const suffix = others > 0 ? t(` (+${others} more waiting)`) : "";
		send(last, fill("{0} — waiting for you", APP_DISPLAY_NAME), `${label}${suffix}`);
	}

	pi.on("agent_start", async () => {
		runStartedAt = Date.now();
	});

	pi.on("tool_call", async (event) => {
		if (!enabled || !approvalsEnabled || scheduledRun()) return;
		if (!likelyPrompts(event.toolName, event.input)) return;
		const label = `${event.toolName}: ${describe(event.toolName, event.input)}`;
		const timer = setTimeout(() => {
			pending.delete(event.toolCallId);
			announceApproval(label);
		}, APPROVAL_DELAY_MS);
		pending.set(event.toolCallId, { timer, label });
	});

	// Execution started, so the gate is no longer blocking this call.
	pi.on("tool_execution_update", async (event) => clearPending(event.toolCallId));
	pi.on("tool_execution_end", async (event) => clearPending(event.toolCallId));
	// fork: the gate's decision is the point where it stops waiting. A call it
	// allows without a question, or once the question is answered, must not be announced while it runs silently.
	// The gate decides after this module's `tool_call` handler armed the timer (built-in order).
	let unsubscribeDecisions: (() => void) | undefined;

	pi.on("agent_settled", async () => {
		clearPending();
		// fork.9 (CAP-01): nobody waits for a scheduled run; its failures and refusals notify at its end.
		if (!enabled || scheduledRun()) return;
		const elapsed = runStartedAt ? Date.now() - runStartedAt : 0;
		runStartedAt = undefined;
		if (elapsed < MIN_RUN_MS || clientFocused) return;
		send(
			last,
			fill("{0} — done", APP_DISPLAY_NAME),
			`Finished after ${Math.round(elapsed / 1000)}s. Ready for input.`,
		);
	});

	/** fork: the desktop notifications in /settings > Notifications; a change applies to this session too. */
	const notificationsSection = (
		report: (message: string, level: "info" | "warning" | "error") => void,
	): SettingsSection => ({
		domain: "notifications",
		items: () => [
			{
				id: "notify-desktop",
				label: "Desktop notifications",
				description: `A desktop notification when a run of more than ${MIN_RUN_MS / 1000} s ends, and when the agent waits for your approval; none while the Prism window is in front.`,
				currentValue: enabled ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "notify-approvals",
				label: "Approval notifications",
				description: `A desktop notification when the agent has waited ${APPROVAL_DELAY_MS / 1000} s for your approval, at most one per ${APPROVAL_THROTTLE_MS / 1000} s.`,
				currentValue: approvalsEnabled ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "notify-test",
				label: "Test notification",
				description: "Sends a desktop notification now.",
				currentValue: "send",
				values: ["send"],
			},
		],
		onChange: (id, value) => {
			if (id === "notify-test") {
				send(last, fill("{0} — test", APP_DISPLAY_NAME), "Notifications are working.", (delivery) => {
					// fork: the answer may come after the session ended.
					if (!life.alive()) return;
					const { message, level } = deliveryReport(delivery);
					report(message, level);
				});
				return;
			}
			const on = value === "on";
			if (id === "notify-desktop") enabled = on;
			else if (id === "notify-approvals") approvalsEnabled = on;
			else return;
			if (!on) clearPending();
			try {
				saveGlobalSetting(["desktopNotifications", id === "notify-desktop" ? "enabled" : "approvals"], on);
			} catch (error) {
				report(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		unsubscribeDecisions?.();
		unsubscribeDecisions = subscribePermissionDecision((fact) => {
			if (pending.has(fact.toolCallId)) clearPending(fact.toolCallId);
		});
		({ enabled, approvals: approvalsEnabled } = readNotifySettings());
		settingsSection = notificationsSection((message, level) => ctx.ui.notify(message, level));
		setSettingsSection(SETTINGS_OWNER, settingsSection);
	});

	pi.on("session_shutdown", async () => {
		unsubscribeDecisions?.();
		unsubscribeDecisions = undefined;
		clearPending();
		// A session started since then has put its own section in place: leave it.
		if (settingsSection && settingsSections().includes(settingsSection))
			setSettingsSection(SETTINGS_OWNER, undefined);
		settingsSection = undefined;
	});
}
