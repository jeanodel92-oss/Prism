/** fork: opt-in local JSONL timeline of observable tool operations. */
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { t } from "./i18n/index.ts";
import { subscribePermissionDecision } from "./permissions.ts";
import { getLastRequestId, redact } from "./request-inspector.ts";
import type { TraceRecord } from "./trace-record.ts";
import { redactWebSecrets } from "./web-search-config.ts";

const MAX_PARAMETER_LENGTH = 16_000;

const readers = new WeakMap<ExtensionContext["sessionManager"], () => object>();

export function traceSnapshot(ctx: ExtensionContext): object | undefined {
	return readers.get(ctx.sessionManager)?.();
}

const STATE_LABELS: Record<TraceRecord["state"], string> = {
	called: "called",
	allowed_by_rule: "allowed by a rule",
	asked_granted_once: "allowed once when asked",
	asked_granted_timed: "allowed for 15 minutes when asked",
	asked_granted_session: "allowed for the session when asked",
	asked_granted_always: "always allowed when asked",
	denied: "denied",
	blocked: "blocked",
	success: "succeeded",
	error: "failed",
};

function isTraceRecord(value: unknown): value is TraceRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<TraceRecord>;
	return (
		record.schemaVersion === 1 &&
		typeof record.timestamp === "string" &&
		typeof record.sessionId === "string" &&
		typeof record.toolCallId === "string" &&
		typeof record.turnIndex === "number" &&
		typeof record.toolName === "string"
	);
}

async function loadStoredSecrets(): Promise<string[]> {
	try {
		const auth = AuthStorage.create();
		const secrets: string[] = [];
		for (const { providerId } of await auth.list()) {
			const credential = await auth.read(providerId);
			if (!credential) continue;
			const collect = (value: unknown) => {
				if (typeof value === "string" && value.length > 0) secrets.push(value);
				else if (value && typeof value === "object") Object.values(value).forEach(collect);
			};
			collect(credential);
		}
		return secrets;
	} catch {
		return [];
	}
}

/** The inspector's masking, and the stored keys Prism resolved in memory (a `!command` key), also URL-encoded. */
function maskSecrets(value: unknown, secrets: readonly string[]): unknown {
	return redact(value, "", undefined, (text) => redactWebSecrets(text, secrets));
}

function summarize(value: unknown, secrets: readonly string[]): string {
	const safe = maskSecrets(value, secrets);
	const text = typeof safe === "string" ? safe : JSON.stringify(safe);
	return (text ?? String(safe)).replace(/\s+/g, " ").slice(0, 240);
}

function pruneTraces(directory: string, days: number): void {
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
	for (const name of readdirSync(directory)) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(directory, name);
		try {
			if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
		} catch {}
	}
}

export default function traceExtension(pi: ExtensionAPI): void {
	const state = { records: [] as TraceRecord[], failed: false, enabled: false, file: "" };
	let cleanupSession: (() => void) | undefined;
	pi.registerCommand("trace", {
		description: t("Show the current session's operation trace"),
		handler: async (_args, ctx) => {
			if (!state.enabled) {
				ctx.ui.notify(t("Tracing is off. Turn it on in /settings > Privacy > Operation trace, then run /reload."));
				return;
			}
			const lines = state.records.map(
				(record) =>
					`${record.timestamp}  ${record.toolName}  ${t(STATE_LABELS[record.state])}${record.type === "result" ? ` (${record.durationMs ?? 0} ms)` : ""}`,
			);
			ctx.ui.notify(`${lines.join("\n") || t("No operations traced yet.")}\n${t("Trace file")}: ${state.file}`);
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		cleanupSession?.();
		cleanupSession = undefined;
		state.records = [];
		state.failed = false;
		state.enabled = false;
		state.file = "";
		let secrets: string[] = [];
		readers.set(ctx.sessionManager, () => ({
			enabled: state.enabled,
			failed: state.failed,
			file: state.file,
			records: state.records.map((record) => ({
				...(maskSecrets(record, secrets) as TraceRecord),
				label: t(STATE_LABELS[record.state] ?? "unknown"),
			})),
		}));
		const settings = pi.getSettings();
		if (settings.traceEnabled !== true) return;
		const directory = join(getAgentDir(), "traces");
		try {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			chmodSync(directory, 0o700);
			const retention = settings.traceRetentionDays;
			pruneTraces(
				directory,
				typeof retention === "number" && Number.isFinite(retention) ? Math.max(1, Math.floor(retention)) : 7,
			);
		} catch (error) {
			console.error(`Operation trace disabled: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		state.enabled = true;
		secrets = await loadStoredSecrets();
		let turnIndex = 0;
		const starts = new Map<string, number>();
		const resultIds = new Set<string>();
		const sessionId = ctx.sessionManager.getSessionId();
		state.file = join(directory, `${sessionId}.jsonl`);
		try {
			chmodSync(state.file, 0o600);
		} catch {}
		try {
			for (const line of readFileSync(state.file, "utf8").split("\n")) {
				if (!line) continue;
				try {
					const record: unknown = JSON.parse(line);
					if (isTraceRecord(record) && record.sessionId === sessionId) state.records.push(record);
				} catch {}
			}
		} catch {}
		const write = (record: TraceRecord) => {
			if (state.failed) return;
			try {
				appendFileSync(state.file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
				state.records.push(record);
			} catch (error) {
				state.failed = true;
				ctx.ui.notify(t("Could not write operation trace; tracing stopped for this session."), "error");
				console.error(`Could not write operation trace: ${error instanceof Error ? error.message : String(error)}`);
			}
		};
		const common = (
			type: TraceRecord["type"],
			operationId: string,
			toolName: string,
			extra: Partial<TraceRecord> = {},
		): TraceRecord => ({
			schemaVersion: 1,
			timestamp: new Date().toISOString(),
			type,
			state: "called",
			sessionId,
			turnIndex,
			toolCallId: operationId,
			toolName,
			...(getLastRequestId() !== undefined ? { requestId: getLastRequestId() } : {}),
			...extra,
		});
		const disposers = [
			pi.on("turn_start", (event) => {
				turnIndex = event.turnIndex;
			}),
		];
		disposers.push(
			pi.on("tool_call", async (event) => {
				// Providers may reuse a tool call id in a later turn: a new call starts a new operation.
				resultIds.delete(event.toolCallId);
				const raw = JSON.stringify(maskSecrets(event.input, secrets)) ?? "null";
				const parameters =
					raw.length > MAX_PARAMETER_LENGTH
						? { truncated: raw.slice(0, MAX_PARAMETER_LENGTH), marker: "[TRUNCATED]", originalLength: raw.length }
						: (JSON.parse(raw) as unknown);
				write(common("operation", event.toolCallId, event.toolName, { parameters, parameterLength: raw.length }));
			}),
		);
		disposers.push(
			pi.on("tool_execution_start", (event) => {
				starts.set(event.toolCallId, Date.now());
			}),
		);
		disposers.push(
			pi.on("tool_result", (event) => {
				if (resultIds.has(event.toolCallId)) return;
				const result = event.content.map((part) => (part.type === "text" ? part.text : "[image]")).join(" ");
				write(
					common("result", event.toolCallId, event.toolName, {
						state: event.isError ? "error" : "success",
						result: summarize(result, secrets),
						durationMs: Math.max(0, Date.now() - (starts.get(event.toolCallId) ?? Date.now())),
					}),
				);
				resultIds.add(event.toolCallId);
				starts.delete(event.toolCallId);
			}),
		);
		const unsubscribe = subscribePermissionDecision((event) => {
			if (event.sessionId !== sessionId) return;
			write(
				common("permission", event.toolCallId, event.toolName, {
					state: event.decision,
					result: redactWebSecrets(String(maskSecrets(event.reason, secrets)), secrets),
				}),
			);
			if ((event.decision === "denied" || event.decision === "blocked") && !resultIds.has(event.toolCallId)) {
				write(
					common("result", event.toolCallId, event.toolName, {
						state: "error",
						result: redactWebSecrets(String(maskSecrets(event.reason, secrets)), secrets),
						durationMs: 0,
					}),
				);
				resultIds.add(event.toolCallId);
				starts.delete(event.toolCallId);
			}
		});
		cleanupSession = () => {
			for (const dispose of disposers) dispose();
			unsubscribe();
		};
	});
	pi.on("session_shutdown", (_event, ctx) => {
		readers.delete(ctx.sessionManager);
		cleanupSession?.();
		cleanupSession = undefined;
		state.enabled = false;
	});
}
