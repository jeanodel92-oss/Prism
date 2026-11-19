#!/usr/bin/env node
// A stand-in for `claude -p` in stream-json mode, for test/fork-claude-code.test.ts.
// It answers `initialize` with two models; a user message containing "TOOL" makes it call Prism's `bash`
// tool through the MCP server of --mcp-config, then answer with what the tool returned; any other message is
// echoed back. Every user message received is appended to $FAKE_CLAUDE_LOG with the process's arguments.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};
const mcpFile = flag("--mcp-config");
const mcp = mcpFile ? Object.values(JSON.parse(readFileSync(mcpFile, "utf-8")).mcpServers)[0] : undefined;
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const log = (value) => {
	if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(value)}\n`);
};
if (process.env.FAKE_CLAUDE_CRASH) {
	process.stderr.write("fake claude: not logged in\n");
	process.exit(3);
}

let rpcId = 0;
async function rpc(method, params) {
	const response = await fetch(mcp.url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...mcp.headers },
		body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
	});
	return (await response.json()).result;
}

let message = 0;
function answer(blocks, stopReason) {
	const id = `msg_${++message}`;
	out({ type: "stream_event", event: { type: "message_start", message: { id, model: "fake-model", usage: { input_tokens: 7, output_tokens: 1 } } } });
	blocks.forEach((block, index) => {
		if (block.type === "text") {
			out({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "text", text: "" } } });
			out({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } } });
		} else {
			out({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } } });
			out({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } } });
		}
		out({ type: "stream_event", event: { type: "content_block_stop", index } });
	});
	out({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } } });
	out({ type: "stream_event", event: { type: "message_stop" } });
}

let calls = 0;
async function turn(text) {
	if (text.includes("TOOL") && mcp) {
		await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } });
		const { tools } = await rpc("tools/list", {});
		const tool = (tools.find((entry) => entry.name === "bash") ?? tools[0]).name;
		const id = `toolu_${++calls}`;
		answer([{ type: "text", text: "Running." }, { type: "tool_use", id, name: `mcp__prism__${tool}`, input: { command: "echo hi" } }], "tool_use");
		const result = await rpc("tools/call", { name: tool, arguments: { command: "echo hi" } });
		out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result.content }] } });
		answer([{ type: "text", text: `tool said: ${result.content.map((block) => block.text).join("")}` }], "end_turn");
	} else {
		answer([{ type: "text", text: `echo: ${text}` }], "end_turn");
	}
	out({ type: "result", subtype: "success", is_error: false, result: "" });
}

let busy = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
	const value = JSON.parse(line);
	if (value.type === "control_request" && value.request.subtype === "initialize") {
		log({ pid: process.pid, args, control: "initialize" });
		out({
			type: "control_response",
			response: {
				subtype: "success",
				request_id: value.request_id,
				response: {
					models: [
						{ value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
						{ value: "plain", displayName: "Plain" },
					],
					account: process.env.FAKE_CLAUDE_LOGGED_OUT
						? { tokenSource: "none", apiProvider: "firstParty" }
						: process.env.FAKE_CLAUDE_ACCOUNT_ONLY
							? { email: "user@example.com", subscriptionType: "Claude Pro", apiProvider: "firstParty" }
							: { tokenSource: "claude.ai", apiKeySource: "none" },
				},
			},
		});
		return;
	}
	if (value.type !== "user") return;
	const text = value.message.content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
	log({ pid: process.pid, args, text });
	busy = busy.then(() => turn(text));
});
