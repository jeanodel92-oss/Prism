import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness } from "../suite/harness.ts";

const [sessionDir, readyFile] = process.argv.slice(2);
if (!sessionDir || !readyFile) throw new Error("Expected session directory and ready file");
const cwd = dirname(sessionDir);
const harness = await createHarness({
	sessionManager: SessionManager.create(cwd, sessionDir, { id: "resume-kill-test" }),
	tools: [
		{
			name: "wait_tool",
			label: "Wait tool",
			description: "Blocks until the process is killed",
			parameters: Type.Object({ target: Type.String() }),
			async execute() {
				writeFileSync(readyFile, harness.session.sessionFile ?? "missing session file");
				return new Promise(() => {});
			},
		},
	],
});
harness.setResponses([
	fauxAssistantMessage(fauxToolCall("wait_tool", { target: "a long operation" }), { stopReason: "toolUse" }),
]);
// A pending promise alone lets Node exit before the parent can kill the tool process.
const keepAlive = setInterval(() => {}, 1_000);
try {
	await harness.session.prompt("start the operation");
} finally {
	clearInterval(keepAlive);
}
