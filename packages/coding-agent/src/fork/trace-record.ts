/** fork: the small, versioned fact shared by traces and future diagnostics. */
export interface TraceRecord {
	schemaVersion: 1;
	timestamp: string;
	type: "operation" | "permission" | "result";
	state:
		| "called"
		| "allowed_by_rule"
		| "asked_granted_once"
		| "asked_granted_timed"
		| "asked_granted_session"
		| "asked_granted_always"
		| "denied"
		| "blocked"
		| "success"
		| "error";
	sessionId: string;
	turnIndex: number;
	toolCallId: string;
	requestId?: number;
	toolName: string;
	parameters?: unknown;
	parameterLength?: number;
	result?: string;
	durationMs?: number;
}
