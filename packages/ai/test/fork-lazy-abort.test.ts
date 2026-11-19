import { describe, expect, it } from "vitest";
import { lazyStream } from "../src/api/lazy.ts";
import type { Api, Model } from "../src/types.ts";

const model = { id: "mock", api: "openai-responses", provider: "openai" } as unknown as Model<Api>;

describe("fork: a setup that fails", () => {
	it("is an interrupt when it was aborted, not a model failure", async () => {
		const error = new Error("This operation was aborted");
		error.name = "AbortError";
		const message = await lazyStream(model, () => Promise.reject(error)).result();
		expect(message.stopReason).toBe("aborted");
	});

	it("stays an error otherwise", async () => {
		const message = await lazyStream(model, () => Promise.reject(new Error("no route"))).result();
		expect(message.stopReason).toBe("error");
	});
});
