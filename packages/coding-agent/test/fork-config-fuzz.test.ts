import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { readAgents } from "../src/fork/agents.ts";
import { readCapabilities } from "../src/fork/capability-store.ts";
import { readModelCorrection } from "../src/fork/model-settings.ts";
import permissionsExtension, { subscribePermissionDecision } from "../src/fork/permissions.ts";
import { isWebSearchProvider, validateWebSearchUrl } from "../src/fork/web-search-config.ts";
import { createHarness, getToolResult } from "./suite/harness.ts";

function makeRandom(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

it("fuzzes fork config readers with isolated files and a replayable corpus", async () => {
	const seed = Number(process.env.PI_FUZZ_SEED ?? 7_704);
	const random = makeRandom(seed);
	const started = process.cpuUsage();
	const tempDir = await mkdtemp(join(tmpdir(), "prism-fork-config-fuzz-"));
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "project");
	const file = join(agentDir, "models.json");
	const capabilityFile = join(agentDir, "capabilities.json");
	const corpus = [
		'{"providers":{}}',
		'{"providers":{"local":{"baseUrl":"http://127.0.0.1","api":"openai-completions","models":[]}}}',
		'{"consult":{"budget":{"maxTurns":3,"maxTools":8}}}',
		'{"default":{"maxTurns":3},"models":{"local":{"maxTools":4}}}',
		'{"local/model":{"vision":"yes","tools":"unknown","reasoning":"no"}}',
		'{"mode":"unrestricted","allow":["write(**)"]}',
		'{"allow":123,"deny":"nope","tools":false}',
		'{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
		"{broken",
		"",
		"\ufeff{}",
		JSON.stringify({ nested: Array.from({ length: 40 }, (_, index) => ({ [`k${index}`]: [] })) }),
	];
	try {
		await mkdir(agentDir, { recursive: true });
		await mkdir(cwd, { recursive: true });
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "valid.md"),
			"---\nname: valid\ndescription: ok\ntools: read\n---\nhello\n",
		);
		const seedConfig = JSON.stringify({ providers: { local: { modelOverrides: { m: { maxTokens: 512 } } } } });
		for (let index = 0; index < 180; index++) {
			let input = corpus[Math.floor(random() * corpus.length)]!;
			if (random() < 0.3) input = `${input.slice(0, Math.floor(random() * (input.length + 1)))}\u001b`;
			if (random() < 0.1) input = `${input}${"x".repeat(4096)}`;
			try {
				await writeFile(file, index % 17 === 0 ? Buffer.from([0xff, 0xfe, 0x80, 0x00]) : input);
				await writeFile(capabilityFile, input);
				await writeFile(join(agentDir, "settings.json"), input);
				try {
					const models = await ModelConfig.load(file);
					expect(models.getProviderIds(), `seed=${seed} case=${index}`).toBeInstanceOf(Array);
				} catch (error) {
					expect(error, `seed=${seed} case=${index}`).toBeInstanceOf(Error);
				}
				const settings = SettingsManager.create(cwd, agentDir).getSettings();
				expect(settings, `seed=${seed} case=${index}`).toBeTypeOf("object");
				readCapabilities(capabilityFile, "local", "model");
				try {
					readModelCorrection(file, "local", "m");
				} catch (error) {
					expect(error, `seed=${seed} case=${index}`).toBeInstanceOf(Error);
				}
				expect(readAgents(agentDir), `seed=${seed} case=${index}`).toBeInstanceOf(Array);
				expect(isWebSearchProvider(random() < 0.5 ? "exa" : input), `seed=${seed} case=${index}`).toBeTypeOf(
					"boolean",
				);
				try {
					validateWebSearchUrl(input);
				} catch (error) {
					expect(error, `seed=${seed} case=${index}`).toBeInstanceOf(Error);
				}
				if (index === 0) {
					await writeFile(file, seedConfig);
					readModelCorrection(file, "local", "m");
				}
				expect(Object.prototype, `seed=${seed} case=${index}`).not.toHaveProperty("polluted");
			} catch (error) {
				throw new Error(`Fork config fuzz failure seed=${seed} case=${index}: ${String(error)}`);
			}
		}
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
	// CPU time, not wall time: 0.15 s of CPU here, but 4.4 s of wall time on the CI
	// runner's busy disk. A parser gone pathological still burns the budget.
	const used = process.cpuUsage(started);
	expect((used.user + used.system) / 1000, `seed=${seed} exceeded 4000ms of CPU`).toBeLessThan(4_000);
}, 60_000);

it("permissions.json rejects a non-array allow rule without crashing", async () => {
	// Defect: an object in allow reaches raw.map in the gate; minimal reproducer: {"allow":{}}.
	const caseMessage = `seed=${Number(process.env.PI_FUZZ_SEED ?? 7_704)} case=permissions-wrong-allow-type`;
	const tempDir = await mkdtemp(join(tmpdir(), "prism-permissions-fuzz-"));
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = tempDir;
	const harness = await createHarness({
		extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
	});
	const decisions: string[] = [];
	const unsubscribe = subscribePermissionDecision((fact) => decisions.push(fact.decision));
	try {
		await writeFile(join(tempDir, "permissions.json"), '{"allow":{}}');
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "ordinary.txt", content: "x" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("check permissions config");
		expect(getToolResult(harness, "write").isError, caseMessage).toBe(true);
		expect(decisions, caseMessage).toContain("blocked");
	} finally {
		unsubscribe();
		harness.cleanup();
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		await rm(tempDir, { recursive: true, force: true });
	}
});

it("keeps malformed permissions.json at the default ask boundary", async () => {
	const caseMessage = `seed=${Number(process.env.PI_FUZZ_SEED ?? 7_704)} case=permissions-invalid-json`;
	const tempDir = await mkdtemp(join(tmpdir(), "prism-permissions-fuzz-"));
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = tempDir;
	const harness = await createHarness({
		extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
	});
	const decisions: string[] = [];
	const unsubscribe = subscribePermissionDecision((fact) => decisions.push(fact.decision));
	try {
		await writeFile(join(tempDir, "permissions.json"), "{broken");
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "ordinary.txt", content: "x" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("check permissions config");
		expect(getToolResult(harness, "write").isError, caseMessage).toBe(true);
		expect(decisions, caseMessage).toContain("blocked");
	} finally {
		unsubscribe();
		harness.cleanup();
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		await rm(tempDir, { recursive: true, force: true });
	}
});
