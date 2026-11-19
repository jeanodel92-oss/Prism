// a file added to a message from outside the project (a PDF, a document, a long text)
// is copied into the session's private /tmp for the agent's tools, kept with the session and restored on resume.
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	type AttachTarget,
	attachFile,
	fileNote,
	keepChangedAttachments,
	MAX_TEXT_BYTES,
	pastedFiles,
	restoreAttachments,
} from "../src/fork/file-attachments.ts";
import { pastedImagesIn } from "../src/fork/image-attachments.ts";
import {
	removeSessionTmpDir,
	type SandboxRuntime,
	sessionTmpDir,
	setSessionSandbox,
} from "../src/fork/sandbox/runtime.ts";

import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const mocks = vi.hoisted(() => ({ readClipboardFilePaths: vi.fn<() => Promise<string[] | null>>() }));
vi.mock("../src/utils/clipboard.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	readClipboardFilePaths: mocks.readClipboardFilePaths,
}));
vi.mock("../src/utils/clipboard-image.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	readClipboardImage: vi.fn(async () => null),
}));

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);
const PDF = Buffer.from("%PDF-1.4\n\0\x01binary");

let root: string;
let target: AttachTarget;
let sessionId: string;

beforeEach(() => {
	root = join(tmpdir(), `prism-attach-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "project"), { recursive: true });
	mkdirSync(join(root, "outside"), { recursive: true });
	mkdirSync(join(root, "sessions"), { recursive: true });
	sessionId = `attach-${Math.random().toString(36).slice(2)}`;
	target = { cwd: join(root, "project"), sessionId, sessionFile: join(root, "sessions", "s.jsonl"), session: {} };
});
afterEach(() => {
	removeSessionTmpDir(sessionId);
	rmSync(root, { recursive: true, force: true });
});

const outside = (name: string, bytes: Buffer | string) => {
	const path = join(root, "outside", name);
	writeFileSync(path, bytes);
	return path;
};

test("an image goes as an image and a short text as its content", () => {
	expect(attachFile(outside("shot.png", PNG), target)).toEqual({
		kind: "image",
		name: "shot.png",
		mimeType: "image/png",
		data: PNG.toString("base64"),
	});
	const notes = outside("notes.md", "# hello\n");
	expect(attachFile(notes, target)).toEqual({ kind: "text", name: "notes.md", path: notes, text: "# hello\n" });
	expect(existsSync(join(sessionTmpDir(sessionId), "attachments"))).toBe(false);
});

test("any other file outside the project is copied into the private /tmp and kept with the session", () => {
	const pdf = outside("report.pdf", PDF);
	const attached = attachFile(pdf, target);
	const tmp = join(sessionTmpDir(sessionId), "attachments");
	expect(attached).toEqual({
		kind: "file",
		name: "report.pdf",
		path: join(tmp, "report.pdf"),
		size: PDF.length,
		copied: true,
	});
	expect(readFileSync(join(tmp, "report.pdf"))).toEqual(PDF);
	expect(readFileSync(join(root, "sessions", "s.attachments", "report.pdf"))).toEqual(PDF);
	expect(readFileSync(pdf)).toEqual(PDF);
	expect(fileNote(attached as Extract<typeof attached, { kind: "file" }>)).toBe(
		`<file name="${join(tmp, "report.pdf")}">\n[1 KB, a copy the user attached; read or change it with your tools, the original is not reachable]\n</file>\n`,
	);

	// A second file of the same name does not replace the first.
	const other = join(root, "outside", "again");
	mkdirSync(other);
	writeFileSync(join(other, "report.pdf"), "%PDF other\0");
	expect(attachFile(join(other, "report.pdf"), target)).toMatchObject({ path: join(tmp, "report-2.pdf") });

	// A text over the limit is copied too, rather than refused.
	const big = outside("big.txt", "a".repeat(MAX_TEXT_BYTES + 1));
	expect(attachFile(big, target)).toMatchObject({ kind: "file", path: join(tmp, "big.txt"), copied: true });
});

test("a sandboxed session gets the copy's path as its commands see it, at /tmp", () => {
	const session = {};
	setSessionSandbox(session, {} as SandboxRuntime);
	expect(attachFile(outside("deck.pptx", PDF), { ...target, session })).toMatchObject({
		path: "/tmp/attachments/deck.pptx",
		copied: true,
	});
	setSessionSandbox(session, undefined);
});

test("a file of the project stays its path, and what cannot be attached says why", () => {
	const inside = join(root, "project", "data.bin");
	writeFileSync(inside, PDF);
	expect(attachFile(inside, target)).toEqual({
		kind: "file",
		name: "data.bin",
		path: inside,
		size: PDF.length,
		copied: false,
	});
	expect(fileNote({ path: inside, size: PDF.length, copied: false })).toContain(
		"a file of the project the user attached",
	);
	expect(attachFile(join(root, "outside"), target)).toMatchObject({ kind: "error", error: "outside is not a file" });
	expect(attachFile(join(root, "outside", "missing.pdf"), target)).toMatchObject({
		kind: "error",
		name: "missing.pdf",
	});
	expect(existsSync(join(root, "sessions", "s.attachments"))).toBe(false);
});

test("an unsaved session's copy is not kept", () => {
	attachFile(outside("a.zip", PDF), { ...target, sessionFile: undefined });
	expect(existsSync(join(sessionTmpDir(sessionId), "attachments", "a.zip"))).toBe(true);
	expect(existsSync(join(root, "sessions", "s.attachments"))).toBe(false);
});

test("a resumed session gets its copies back in its new private /tmp", () => {
	attachFile(outside("report.pdf", PDF), target);
	removeSessionTmpDir(sessionId);
	expect(existsSync(join(sessionTmpDir(sessionId), "attachments"))).toBe(false);
	restoreAttachments(target);
	expect(readFileSync(join(sessionTmpDir(sessionId), "attachments", "report.pdf"))).toEqual(PDF);
	// Restoring again keeps a copy the agent changed.
	writeFileSync(join(sessionTmpDir(sessionId), "attachments", "report.pdf"), "changed");
	restoreAttachments(target);
	expect(readFileSync(join(sessionTmpDir(sessionId), "attachments", "report.pdf"), "utf8")).toBe("changed");
});

// the copy the agent changed was lost when the session closed; resuming brought
// back the copy as it was attached.
test.runIf(process.platform === "linux")("a copy the agent changed comes back changed after the session closed", () => {
	attachFile(outside("report.pdf", PDF), target);
	attachFile(outside("notes.zip", PDF), target);
	const tmp = join(sessionTmpDir(sessionId), "attachments");
	writeFileSync(join(tmp, "report.pdf"), "changed by the agent");
	// A link the agent put in place of a copy is not followed: the saved copy stays.
	outside("secret.txt", "secret");
	rmSync(join(tmp, "notes.zip"));
	symlinkSync(join(root, "outside", "secret.txt"), join(tmp, "notes.zip"));
	keepChangedAttachments(target);
	removeSessionTmpDir(sessionId);
	restoreAttachments(target);
	const resumed = join(sessionTmpDir(sessionId), "attachments");
	expect(readFileSync(join(resumed, "report.pdf"), "utf8")).toBe("changed by the agent");
	expect(readFileSync(join(resumed, "notes.zip"))).toEqual(PDF);
	expect(readFileSync(join(root, "sessions", "s.attachments", "notes.zip"))).toEqual(PDF);
});

test("files copied in the file manager and pasted in the terminal: an image, a copy, or the path as before", () => {
	const shown = pastedFiles(
		[outside("shot.png", PNG), outside("notes.txt", "hi\n"), outside("doc.pdf", PDF), join(root, "nowhere.pdf")],
		() => target,
	);
	expect(pastedImagesIn(shown[0]!)).toEqual([{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
	const tmp = join(sessionTmpDir(sessionId), "attachments");
	// A short text is not put in the editor: its copy's path, as for any other file.
	expect(shown.slice(1)).toEqual([join(tmp, "notes.txt"), join(tmp, "doc.pdf"), join(root, "nowhere.pdf")]);
	expect(
		pastedFiles(["/x.pdf"], () => {
			throw new Error("no session");
		}),
	).toEqual(["/x.pdf"]);
});

test("the terminal's paste key gives a copied PDF as the path of its copy", async () => {
	const pdf = outside("doc.pdf", PDF);
	mocks.readClipboardFilePaths.mockResolvedValue([pdf]);
	const insertTextAtCursor = vi.fn<(text: string) => void>();
	const sessionManager = {
		getCwd: () => target.cwd,
		getSessionId: () => sessionId,
		getSessionFile: () => target.sessionFile,
	};
	const context = {
		editor: { insertTextAtCursor },
		isBashMode: false,
		sessionManager,
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	const prototype = InteractiveMode.prototype as unknown as {
		handleClipboardPaste(this: typeof context): Promise<void>;
	};
	await prototype.handleClipboardPaste.call(context);
	expect(context.showError).not.toHaveBeenCalled();
	expect(insertTextAtCursor).toHaveBeenCalledWith(join(sessionTmpDir(sessionId), "attachments", "doc.pdf"));
});
