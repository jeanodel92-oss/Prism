// fork: the <machine> section reaches the model, and stays the same from one prompt to
// the next, so it never resends the system prompt.

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import machineContext from "../../src/fork/machine-context.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("fork: the user's machine in the system prompt", () => {
	let harness: Harness | undefined;
	afterEach(() => harness?.cleanup());

	it("sends a <machine> section once and keeps it for the session", async () => {
		harness = await createHarness({ extensionFactories: [machineContext] });
		const seen: Array<string | undefined> = [];
		const capture = (context: { messages: Array<{ role: string }> }) => {
			const system = context.messages.find((message) => (message.role as string) === "system") as
				| { sections?: Record<string, string> }
				| undefined;
			seen.push(system?.sections?.machine);
			return fauxAssistantMessage("ok");
		};
		harness.setResponses([capture, capture]);
		await harness.session.prompt("How much disk space do I have?");
		await harness.session.prompt("And which shell?");
		expect(seen[0]).toMatch(/^<machine>\nSystem: .+\nHardware: .*RAM \d+ GB/);
		expect(seen[1]).toBe(seen[0]);
	});
});
