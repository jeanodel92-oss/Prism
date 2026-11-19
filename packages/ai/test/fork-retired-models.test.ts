// fork: the weekly catalog refresh keeps retired models that the code or tests still name.
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { keepRetiredModels, readPackageSources, readPreviousSnapshot } from "../scripts/fork-retired-models.ts";
import type { Api, Model } from "../src/types.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const model = (provider: string, id: string): Model<Api> =>
	({ id, name: id, provider, api: "openai-completions", type: "chat" }) as unknown as Model<Api>;

describe("keepRetiredModels", () => {
	it("carries over a retired model that the source names, marked deprecated, and drops the others", () => {
		const previous = {
			acme: {
				"openai-completions": {
					"chat:named-1": model("acme", "named-1"),
					"chat:unnamed-1": model("acme", "unnamed-1"),
					"chat:live-1": { ...model("acme", "live-1"), name: "old name" },
					"image:named-1": model("acme", "named-1"),
				},
			},
		};
		const chat: Record<string, Record<string, Model<Api>>> = { acme: { "live-1": model("acme", "live-1") } };
		const kept = keepRetiredModels(chat, previous, `getModel("acme", "named-1"); getModel("acme", "live-1");`);
		expect(kept).toEqual(["acme/named-1"]);
		expect(chat.acme["named-1"].deprecated).toBe(true);
		expect(chat.acme["unnamed-1"]).toBeUndefined();
		expect(chat.acme["live-1"].name).toBe("live-1");
	});

	it("recognizes single quotes, template literals and property access on identifier IDs", () => {
		const previous = {
			acme: {
				"openai-completions": {
					"chat:a-1": model("acme", "a-1"),
					"chat:b-1": model("acme", "b-1"),
					"chat:plain": model("acme", "plain"),
					"chat:plainer": model("acme", "plainer"),
				},
			},
		};
		const chat: Record<string, Record<string, Model<Api>>> = {};
		const kept = keepRetiredModels(chat, previous, "x('a-1'); y(`b-1`); MODELS.acme.plain;");
		expect(kept).toEqual(["acme/a-1", "acme/b-1", "acme/plain"]);
	});

	it("restores a model of the committed snapshot that a test names, once it leaves the live catalog", () => {
		const previous = readPreviousSnapshot(packageRoot);
		const source = readPackageSources(join(packageRoot, ".."));
		const chat: Record<string, Record<string, Model<Api>>> = {};
		for (const [provider, byApi] of Object.entries(previous)) {
			for (const models of Object.values(byApi)) {
				for (const [identity, entry] of Object.entries(models)) {
					if (identity.startsWith("chat:") && entry.id !== "zai-org/GLM-5.2-Fast") {
						chat[provider] ??= {};
						chat[provider][entry.id] = entry;
					}
				}
			}
		}
		expect(keepRetiredModels(chat, previous, source)).toEqual(["baseten/zai-org/GLM-5.2-Fast"]);
		expect(chat.baseten["zai-org/GLM-5.2-Fast"].deprecated).toBe(true);
	});
});
