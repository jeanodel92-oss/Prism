// a screenshot pasted in the terminal reaches the model as an image, not as the path of a
// temporary file it had to read.
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ImageContent, UserMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import imageAttachments, { attachPastedImage, pastedImagesIn } from "../src/fork/image-attachments.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const mocks = vi.hoisted(() => ({
	readClipboardFilePaths: vi.fn<() => Promise<string[] | null>>(),
	readClipboardImage: vi.fn<() => Promise<{ bytes: Uint8Array; mimeType: string } | null>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));
vi.mock("../src/utils/clipboard.ts", () => ({
	copyToClipboard: vi.fn(),
	readClipboardFilePaths: mocks.readClipboardFilePaths,
	readClipboardText: mocks.readClipboardText,
}));
vi.mock("../src/utils/clipboard-image.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	readClipboardImage: mocks.readClipboardImage,
}));

// 1×1 pixels, which the session's image normalization accepts.
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);
const harnesses: Harness[] = [];
beforeEach(() => vi.resetAllMocks());
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

test("the paste key puts a placeholder for a copied image in the editor, not a temporary file's path", async () => {
	mocks.readClipboardFilePaths.mockResolvedValue(null);
	mocks.readClipboardImage.mockResolvedValue({ bytes: PNG, mimeType: "image/png" });
	const insertTextAtCursor = vi.fn<(text: string) => void>();
	const context = { editor: { insertTextAtCursor }, showError: vi.fn(), ui: { requestRender: vi.fn() } };
	const prototype = InteractiveMode.prototype as unknown as {
		handleClipboardPaste(this: typeof context): Promise<void>;
	};
	await prototype.handleClipboardPaste.call(context);
	const label = insertTextAtCursor.mock.calls[0]?.[0] ?? "";
	expect(label).toMatch(/^\[Image #\d+\]$/);
	expect(pastedImagesIn(`look at ${label}`)).toEqual([
		{ type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" },
	]);
	expect(context.showError).not.toHaveBeenCalled();
});

test("a message holding the placeholder carries the image to the model", async () => {
	const harness = await createHarness({
		extensionFactories: [{ name: "image-attachments", factory: imageAttachments }],
	});
	harnesses.push(harness);
	const seen: ImageContent[][] = [];
	const record = (context: TranscriptContext) => {
		const user = context.messages.findLast((message) => message.role === "user") as UserMessage;
		seen.push(typeof user.content === "string" ? [] : user.content.filter((part) => part.type === "image"));
		return fauxAssistantMessage("ok");
	};
	harness.setResponses([record, record]);
	const first = attachPastedImage(PNG, "image/png");
	const second = attachPastedImage(PNG, "image/png");

	await harness.session.prompt(`what is in ${first} and ${second}, then ${first} again?`);
	expect(seen[0]?.map((image) => image.mimeType)).toEqual(["image/png", "image/png"]);
	const stored = harness.session.messages.find((message) => message.role === "user") as UserMessage;
	expect(Array.isArray(stored.content) && stored.content.filter((part) => part.type === "image")).toHaveLength(2);

	// A placeholder deleted from the draft leaves its image out; a made-up number attaches nothing.
	await harness.session.prompt("only text, [Image #999999]");
	expect(seen[1]).toEqual([]);

	// sent, an image is no longer kept here.
	expect(pastedImagesIn(`${first} ${second}`)).toEqual([]);

	// Always loaded: --no-extensions and the `extensions` setting turn off only `builtin` modules.
	const entry = builtInExtensions.find(
		(extension) => typeof extension !== "function" && extension.name === "image-attachments",
	);
	expect(entry).toEqual({ name: "image-attachments", factory: imageAttachments });
});

// every paste stayed in memory for the life of the process.
test("the images pasted for a draft go with its session, and stay across a reload", async () => {
	const handlers: Array<(event: { type: string; reason: string }) => unknown> = [];
	imageAttachments({
		on: (type: string, handler: (event: { type: string; reason: string }) => unknown) => {
			if (type === "session_shutdown") handlers.push(handler);
		},
	} as unknown as ExtensionAPI);
	const shutdown = async (reason: string) => {
		for (const handler of handlers) await handler({ type: "session_shutdown", reason });
	};
	const label = attachPastedImage(PNG, "image/png");
	await shutdown("reload");
	expect(pastedImagesIn(label)).toHaveLength(1);
	await shutdown("new");
	expect(pastedImagesIn(label)).toEqual([]);
});
