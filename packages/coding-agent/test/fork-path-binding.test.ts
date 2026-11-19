/**
 * fork: the file Prism reads or writes is the one that was judged.
 *
 * Each case takes the decision (`bindFileCall`, what the permission gate calls), then puts a link or another file on
 * the path, then lets the operation run. Assertion: the "host" folder outside the project is untouched and the
 * operation fails. No waiting hook in the product: the decision and the open are two calls (relecture, point 2).
 */
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { holdFileMutationQueue, withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createWriteTool } from "../src/core/tools/write.ts";
import checkpoints, { type CheckpointPlan } from "../src/fork/checkpoints.ts";
import { attachFile } from "../src/fork/file-attachments.ts";
import { bindFileCall } from "../src/fork/file-binding.ts";
import { hostProgram } from "../src/fork/host-program.ts";
import { handleInspectCommand } from "../src/fork/rpc-inspect.ts";
import { sessionTmpDir } from "../src/fork/sandbox/runtime.ts";
import { smallPdf } from "./fork-pdf-fixture.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

let root: string;
let project: string;
let host: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "prism-path-binding-")));
	project = join(root, "project");
	host = join(root, "host");
	mkdirSync(join(project, "src"), { recursive: true });
	mkdirSync(host);
	writeFileSync(join(host, "a.ts"), "host original\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Puts a link to the host folder where `src` was, as a background command would. */
const linkSrcToHost = () => {
	rmSync(join(project, "src"), { recursive: true, force: true });
	symlinkSync(host, join(project, "src"));
};

const hostIntact = () => expect(readFileSync(join(host, "a.ts"), "utf8")).toBe("host original\n");

describe("fork: a file tool opens the object its permission judged", () => {
	it("write: a folder of the path made a link after the decision is not followed", async () => {
		const path = join(project, "src", "a.ts");
		bindFileCall("w1", path);
		linkSrcToHost();
		await expect(createWriteTool(project).execute("w1", { path, content: "model\n" })).rejects.toThrow(
			/symbolic link on this path was not followed/,
		);
		hostIntact();
	});

	it("write: a folder the write creates, made a link meanwhile, is not followed", async () => {
		const path = join(project, "src", "new", "b.ts");
		bindFileCall("w2", path);
		symlinkSync(host, join(project, "src", "new"));
		await expect(createWriteTool(project).execute("w2", { path, content: "model\n" })).rejects.toThrow();
		expect(existsSync(join(host, "b.ts"))).toBe(false);
	});

	it("write: a link put in place of the file is not followed", async () => {
		const path = join(project, "src", "a.ts");
		writeFileSync(path, "project\n");
		bindFileCall("w3", path);
		rmSync(path);
		symlinkSync(join(host, "a.ts"), path);
		await expect(createWriteTool(project).execute("w3", { path, content: "model\n" })).rejects.toThrow();
		hostIntact();
	});

	it("write: another file put under the name is refused", async () => {
		const path = join(project, "src", "a.ts");
		writeFileSync(path, "project\n");
		bindFileCall("w4", path);
		writeFileSync(join(project, "other"), "other\n");
		renameSync(join(project, "other"), path);
		await expect(createWriteTool(project).execute("w4", { path, content: "model\n" })).rejects.toThrow(
			/another file was put under this name/,
		);
		expect(readFileSync(path, "utf8")).toBe("other\n");
	});

	it("write: a hard link to a host file made after the decision is refused", async () => {
		const path = join(project, "src", "a.ts");
		writeFileSync(path, "project\n");
		bindFileCall("w5", path);
		rmSync(path);
		linkSync(join(host, "a.ts"), path);
		await expect(createWriteTool(project).execute("w5", { path, content: "model\n" })).rejects.toThrow();
		hostIntact();
	});

	it("write: a link judged at the decision is followed, as before (piège 5)", async () => {
		mkdirSync(join(project, "real"));
		symlinkSync(join(project, "real"), join(project, "linked"));
		const path = join(project, "linked", "c.ts");
		bindFileCall("w6", path);
		await createWriteTool(project).execute("w6", { path, content: "through the judged link\n" });
		expect(readFileSync(join(project, "real", "c.ts"), "utf8")).toBe("through the judged link\n");
	});

	it("edit: reads and writes the judged file, not the host one a link leads to after", async () => {
		const path = join(project, "src", "a.ts");
		writeFileSync(path, "host original\n");
		bindFileCall("e1", path);
		linkSrcToHost();
		await expect(
			createEditTool(project).execute("e1", { path, edits: [{ oldText: "original", newText: "edited" }] }),
		).rejects.toThrow();
		hostIntact();
	});

	it("edit: a judged file is edited in place", async () => {
		const path = join(project, "src", "a.ts");
		writeFileSync(path, "one two\n");
		bindFileCall("e2", path);
		await createEditTool(project).execute("e2", { path, edits: [{ oldText: "two", newText: "three four" }] });
		expect(readFileSync(path, "utf8")).toBe("one three four\n");
	});

	it("read: returns nothing from a host file a link leads to after the decision", async () => {
		writeFileSync(join(host, "secret.txt"), "host-secret\n");
		const path = join(project, "src", "secret.txt");
		writeFileSync(path, "project text\n");
		bindFileCall("r1", path);
		linkSrcToHost();
		const result = await createReadTool(project)
			.execute("r1", { path })
			.then(
				(value) => JSON.stringify(value),
				(error: Error) => error.message,
			);
		expect(result).not.toContain("host-secret");
	});

	it("read: a judged PDF is extracted through its descriptor, by the real programs", async (context) => {
		if (!hostProgram("pdftotext") || !hostProgram("bwrap")) return context.skip("pdftotext or bubblewrap missing");
		const path = join(project, "src", "doc.pdf");
		writeFileSync(path, smallPdf());
		bindFileCall("r3", path);
		expect(JSON.stringify(await createReadTool(project).execute("r3", { path }))).toContain("Hello Prism");
	});

	it("read: the content checks and the bytes come from one state of the file", async () => {
		const path = join(project, "src", "data.txt");
		writeFileSync(path, "plain text\n");
		// A write holds the queue; the read starts meanwhile, then the write puts binary bytes.
		const release = await holdFileMutationQueue(path);
		const reading = createReadTool(project)
			.execute("r2", { path })
			.then(
				(value) => JSON.stringify(value),
				(error: Error) => `refused: ${error.message}`,
			);
		await new Promise((done) => setTimeout(done, 100));
		writeFileSync(path, Buffer.from([0, 1, 2, 3, 0, 0, 0]));
		release();
		expect(await reading).toMatch(/^refused: .*binary/i);
	});
});

describe("fork: one write queue per file, before and after it exists", () => {
	it("a file created through a linked folder and by its real path share one queue", async () => {
		mkdirSync(join(project, "real"));
		symlinkSync(join(project, "real"), join(project, "link"));
		const order: string[] = [];
		let finish!: () => void;
		const first = withFileMutationQueue(join(project, "link", "new.txt"), async () => {
			order.push("first start");
			await new Promise<void>((done) => {
				finish = done;
			});
			order.push("first end");
		});
		await new Promise((done) => setTimeout(done, 20));
		const second = withFileMutationQueue(join(project, "real", "new.txt"), async () => {
			order.push("second");
		});
		await new Promise((done) => setTimeout(done, 20));
		finish();
		await Promise.all([first, second]);
		expect(order).toEqual(["first start", "first end", "second"]);
	});

	it("a dangling final link and its target share one queue", async () => {
		symlinkSync(join(project, "target.txt"), join(project, "link.txt"));
		const order: string[] = [];
		let finish!: () => void;
		const first = withFileMutationQueue(join(project, "link.txt"), async () => {
			await new Promise<void>((done) => {
				finish = done;
			});
			order.push("first");
		});
		await new Promise((done) => setTimeout(done, 20));
		const second = withFileMutationQueue(join(project, "target.txt"), async () => {
			order.push("second");
		});
		await new Promise((done) => setTimeout(done, 20));
		finish();
		await Promise.all([first, second]);
		expect(order).toEqual(["first", "second"]);
	});
});

describe("fork: Prism's own writes follow no link put since", () => {
	const savedAgent = process.env[ENV_AGENT_DIR];
	const savedHome = process.env.HOME;
	const savedKeyring = process.env.PRISM_SECRET_SERVICE;
	const harnesses: Harness[] = [];

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
		if (savedAgent === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgent;
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedKeyring === undefined) delete process.env.PRISM_SECRET_SERVICE;
		else process.env.PRISM_SECRET_SERVICE = savedKeyring;
	});

	it("/undo restores into the project, not through a link put after the checkpoint", async () => {
		process.env.HOME = root;
		process.env[ENV_AGENT_DIR] = join(root, "agent");
		process.env.PRISM_SECRET_SERVICE = "off";
		const harness = await createHarness({ extensionFactories: [checkpoints] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		const file = join(harness.tempDir, "kept.txt");
		writeFileSync(file, "before\n");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: file, content: "after\n" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("write the fixture");
		expect(readFileSync(file, "utf8")).toBe("after\n");
		const call = (type: string, fields: Record<string, unknown> = {}) =>
			handleInspectCommand({ type, ...fields }, harness.session);
		const plan = (await call("checkpoints_preview", { turn: 1 })) as CheckpointPlan;
		rmSync(file);
		symlinkSync(join(host, "a.ts"), file);
		const result = (await call("checkpoints_restore", { turn: plan.turn, revision: plan.revision })) as {
			failed: string[];
		};
		expect(result.failed).toHaveLength(1);
		hostIntact();
	});

	it("an attachment is not copied through a link the agent put in its /tmp", () => {
		const sessionId = `path-binding-${process.pid}`;
		const tmp = sessionTmpDir(sessionId);
		try {
			rmSync(join(tmp, "attachments"), { recursive: true, force: true });
			symlinkSync(host, join(tmp, "attachments"));
			const outside = join(root, "report.bin");
			writeFileSync(outside, Buffer.from([0, 1, 2, 3]));
			const attached = attachFile(outside, { cwd: project, sessionId, session: {} });
			expect(attached.kind).toBe("error");
			expect(existsSync(join(host, "report.bin"))).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
