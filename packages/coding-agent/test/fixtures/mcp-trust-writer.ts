// another Prism process recording MCP tool fingerprints, for fork-mcp-trust.
// Usage: <agentDir> <prefix> <count> <start at, epoch ms>
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { mcpToolChanges } from "../../src/fork/mcp-trust.ts";

const [agentDir, prefix, count, startAt] = process.argv.slice(2);
if (!agentDir || !prefix) throw new Error("Expected an agent dir and a prefix");
process.env[ENV_AGENT_DIR] = agentDir;
// All writers start together, so their writes overlap.
const wait = Number(startAt) - Date.now();
if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
for (let n = 0; n < Number(count); n++)
	await mcpToolChanges([
		{ name: `mcp__${prefix}__tool${n}`, description: `tool ${n}`, parameters: {}, annotations: {} },
	]);
