/**
 * fork: images of messages queued during a run get the same
 * processing as an idle prompt, with the model's resize profile, and the queue keeps the order of the calls.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ImageContent, type UserMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const processImage = vi.hoisted(() =>
	vi.fn(async (bytes: Uint8Array, mimeType: string) => {
		// The large image takes longer, so a later text-only message would overtake it without ordering.
		const label = Buffer.from(bytes).toString();
		if (label === "large") await new Promise((resolve) => setTimeout(resolve, 30));
		if (label === "slow") await new Promise((resolve) => setTimeout(resolve, 300));
		return { ok: true as const, data: `processed-${label}`, mimeType, hints: [`[processed ${label}]`] };
	}),
);
vi.mock("../../src/utils/image-process.ts", () => ({ processImage }));

const image = (label: string): ImageContent => ({
	type: "image",
	data: Buffer.from(label).toString("base64"),
	mimeType: "image/png",
});

describe("queued images", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		processImage.mockClear();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function waitingHarness() {
		let release: (() => void) | undefined;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await released;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool], settings: { images: { autoResize: true } } });
		harnesses.push(harness);
		if (!harness.session.model) throw new Error("Expected a model");
		const resize = { maxWidth: 100, maxHeight: 100, maxBytes: 5000, jpegQuality: 50 };
		harness.session.model.inputLimits = { images: { resize } };
		const started = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("three"),
		]);
		const run = harness.session.prompt("start");
		await started;
		return {
			harness,
			resize,
			finish: async () => {
				release?.();
				await run;
			},
		};
	}

	function userMessages(harness: Harness): UserMessage[] {
		return harness.session.messages.filter((message): message is UserMessage => message.role === "user");
	}

	it.each(["prompt", "steer", "followUp"] as const)(
		"processes the images of a %s queued during a run",
		async (entry) => {
			const { harness, resize, finish } = await waitingHarness();
			if (entry === "prompt") {
				await harness.session.prompt("look", { images: [image("shot")], streamingBehavior: "followUp" });
			} else {
				await harness.session[entry]("look", [image("shot")]);
			}
			await finish();

			expect(processImage).toHaveBeenCalledWith(expect.any(Uint8Array), "image/png", {
				autoResizeImages: true,
				resizeOptions: resize,
			});
			const queued = userMessages(harness).find((message) => JSON.stringify(message.content).includes("look"));
			expect(queued?.content).toEqual([
				{ type: "text", text: "look\n\n[processed shot]" },
				{ type: "image", data: "processed-shot", mimeType: "image/png" },
			]);
		},
	);

	it("keeps the order of queued messages when an earlier one has images still being processed", async () => {
		const { harness, finish } = await waitingHarness();
		const first = harness.session.followUp("first", [image("large")]);
		const second = harness.session.followUp("second");
		await Promise.all([first, second]);
		expect(harness.session.getFollowUpMessages()).toEqual(["first\n\n[processed large]", "second"]);
		await finish();
		const texts = userMessages(harness).map((message) =>
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		);
		expect(texts.map((parts) => parts[0])).toEqual(["start", "first\n\n[processed large]", "second"]);
	});

	// a message cleared from the queue while its image was being
	// processed was lost, its text not given back with the others.
	it("gives back the text of a message cleared from the queue while its image is processed", async () => {
		const { harness, finish } = await waitingHarness();
		const queued = harness.session.followUp("kept", [image("slow")]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: ["kept"] });
		await queued;
		await finish();
		expect(JSON.stringify(userMessages(harness))).not.toContain("kept");
	});

	// a steer whose image was still processed when the run ended
	// waited in the queue for the next prompt.
	it("delivers in the same run a steer whose image is processed when the run ends", async () => {
		const { harness, finish } = await waitingHarness();
		const queued = harness.session.steer("late", [image("slow")]);
		await finish();
		await queued;
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(JSON.stringify(userMessages(harness))).toContain("late");
		expect(harness.session.isStreaming).toBe(false);
	});
});
