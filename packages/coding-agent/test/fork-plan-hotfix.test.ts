// fork: the plan-mode failure of 2026-10-21. In plan mode, a model asked to read
// .doc and .docx files was refused every extractor and redirection, read the files as raw bytes with
// `read`, and overflowed the context; llama.cpp's overflow message was not recognised, so the session
// stopped instead of compacting and retrying.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, isContextOverflow } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { emitSessionShutdownEvent } from "../src/core/extensions/runner.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { planBridge } from "../src/fork/prism/index.ts";
import {
	classifyPlanModeTool,
	findBlockedCommandSegment,
	PLAN_MODE_BASH_HINT,
} from "../vendor/forks/pi-plan-mode/dist/chunks/chunk-L2CXUWCH.ts";
import planModeExtension from "../vendor/forks/pi-plan-mode/dist/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const blocked = (command: string) => findBlockedCommandSegment(command, {}, "/work", "linux");

describe("plan-mode bash policy", () => {
	it("allows the inspection commands the maintainer's session needed", () => {
		for (const command of [
			"ls /usr/bin 2>/dev/null",
			"grep -r foo . 2>&1 | head -5",
			"which antiword catdoc pandoc 2>/dev/null",
			"cat a.txt >/dev/null && echo ok",
			"cat a.txt > /dev/null",
			"ls &>/dev/null",
			"ls 2>> /dev/null; echo x >&2",
			"antiword Chapitre2.doc",
			"catdoc -w chapitre4.doc | head -c 45000",
			"pandoc -t plain 'notes de cours 1.docx'",
			"pandoc --to=markdown notes.docx",
			"unzip -p 'notes de cours 1.docx' word/document.xml",
			"unzip -l notes.docx",
			"unzip -qq -p notes.docx word/document.xml",
			"pdftotext -layout a.pdf -",
		]) {
			expect(blocked(command), command).toBeUndefined();
		}
	});

	it("still blocks writes, code execution and other redirections", () => {
		for (const command of [
			"ls > out.txt",
			"ls 2>/dev/null>out.txt",
			"ls 2>/dev/null/../out.txt",
			"ls >&3",
			"ls>/dev/null",
			"echo '2>/dev/null' > out.txt",
			"pdftotext a.pdf",
			"pdftotext a.pdf out.txt",
			"unzip notes.docx",
			"unzip -o notes.docx",
			"pandoc notes.docx -o out.md",
			"pandoc -oout.md notes.docx",
			"pandoc --output=out.md notes.docx",
			"pandoc -F ./filter notes.docx",
			"pandoc --lua-filter=f.lua notes.docx",
			"pandoc -t writer.lua notes.docx",
			"pandoc -d defaults.yaml",
			"pandoc --pdf-engine=sh -t pdf notes.docx",
			"pandoc --extract-media=. notes.docx",
			"python3 -c 'print(1)'",
			"antiword $(rm -rf x)",
		]) {
			expect(blocked(command), command).toBeDefined();
		}
	});

	// Review of the modules the Codex review did not read: each of these wrote a file or ran a program
	// when tried in a throwaway folder, and the policy let it through.
	it("blocks writes and programs hidden in option clusters, abbreviations and sed -e", () => {
		for (const command of [
			"sed -n 1p -e 'w out.txt' a.txt",
			"sed -n 1p -e '1e touch x' a.txt",
			"sed -n 1p --expression='w out.txt' a.txt",
			"sed -n 1p --expr='w out.txt' a.txt",
			"sed -n 1p -f script.sed a.txt",
			"sort -uo out.txt a.txt",
			"sort --o=out.txt a.txt",
			"sort --compress=sh a.txt",
			"tree -ao out.txt",
			"fd a.txt -Hx touch",
			"fd a.txt -HX touch",
			"unzip notes.docx -d sub -l",
			"pandoc notes.docx -so out.html",
			"pandoc notes.docx --out=out.html",
			"pandoc notes.docx --filte=prog",
			"pandoc notes.docx --lua-f=x",
			"bat cache --build",
		]) {
			expect(blocked(command), command).toBeDefined();
		}
		for (const command of ["sed -n 1,5p a.txt", "sort -u -k2 a.txt", "tree -a", "fd -H a.txt", "bat a.txt"]) {
			expect(blocked(command), command).toBeUndefined();
		}
	});

	it("checks a configured safe subcommand as one segment, never the whole command", () => {
		const configured = (command: string) => findBlockedCommandSegment(command, { make: ["lint"] }, "/work", "linux");
		expect(configured("make lint")).toBeUndefined();
		expect(configured("make lint && git status")).toBeUndefined();
		expect(configured("make lint; rm -rf src")).toBe("rm -rf src");
		expect(configured("make lint > out.txt")).toBeDefined();
		expect(configured("make lint $(rm a)")).toBeDefined();
	});

	it("tells the model what it may run", () => {
		for (const part of ["cat", "sed -n", "git status", "antiword", "pdftotext FILE -", "2>/dev/null", "2>&1"]) {
			expect(PLAN_MODE_BASH_HINT).toContain(part);
		}
	});

	it("lets a model change folder, and still checks what follows", () => {
		for (const command of ["cd src", "cd src && ls", "cd .. && git status"]) {
			expect(blocked(command), command).toBeUndefined();
		}
		for (const command of ["cd src && rm a", "cd $(rm a)", "cd src; touch a"]) {
			expect(blocked(command), command).toBeDefined();
		}
	});

	// the fork.9 QA saw both refused while they only read.
	it("allows $? and session_search, nothing else that expands", () => {
		for (const command of ['echo "exit=$?"', "ls; echo $?", "grep -c x a.txt; echo $?"]) {
			expect(blocked(command), command).toBeUndefined();
		}
		for (const command of ["echo $HOME", 'echo "$(rm a)"', "echo $?$(rm a)", "echo $??", "echo `rm a`"]) {
			expect(blocked(command), command).toBeDefined();
		}
		const tool = (name: string) =>
			({ name, sourceInfo: { source: "builtin" } }) as Parameters<typeof classifyPlanModeTool>[0];
		expect(classifyPlanModeTool(tool("session_search"))).toBe("read-only");
		expect(classifyPlanModeTool(tool("write"))).toBe("blocked");
	});

	it("strips redirections in linear time", () => {
		const command = `ls${" 2>/dev/null".repeat(50_000)}`;
		const started = performance.now();
		expect(blocked(command)).toBeUndefined();
		expect(performance.now() - started).toBeLessThan(1_500);
	});
});

describe("read refuses binary files", () => {
	const path = process.env.PATH;
	let dir: string | undefined;
	afterEach(() => {
		process.env.PATH = path;
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("names extractors instead of returning raw bytes", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-read-binary-"));
		// The first bytes of a .docx (zip) and a .doc (OLE), and a PDF header followed by text objects.
		writeFileSync(
			join(dir, "notes.docx"),
			Buffer.concat([Buffer.from("PK\x03\x04\x14\x00\x00\x00"), Buffer.alloc(64, 65)]),
		);
		writeFileSync(join(dir, "old.doc"), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]));
		writeFileSync(join(dir, "a.pdf"), `%PDF-1.7\n${"1 0 obj << /Type /Catalog >> endobj\n".repeat(400)}`);
		writeFileSync(join(dir, "text.md"), "# Title\n\nplain text, accents é\n");
		// Extractors that fail, as on these damaged files, whether or not the machine has the real ones.
		const bin = join(dir, "bin");
		mkdirSync(bin);
		for (const program of ["pandoc", "pdftotext"])
			writeFileSync(join(bin, program), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		process.env.PATH = `${bin}:${path}`;
		const tool = createReadTool(dir);
		for (const name of ["notes.docx", "old.doc", "a.pdf"]) {
			await expect(tool.execute("read", { path: name }), name).rejects.toThrow(/binary file.*pdftotext/s);
		}
		const text = await tool.execute("read", { path: "text.md" });
		expect(text.content[0]).toMatchObject({ type: "text", text: "# Title\n\nplain text, accents é\n" });
	});
});

describe("llama.cpp context overflow", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("is recognised, so the session compacts and retries", async () => {
		const message = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "Context size has been exceeded.",
		});
		expect(isContextOverflow(message)).toBe(true);

		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 4000 }],
			tools: [],
			settings: { compaction: { enabled: true, reserveTokens: 10, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compacted history",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first answer")]);
		await harness.session.prompt("first");
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Context size has been exceeded." }),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("second");
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ reason: "overflow", willRetry: true });
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});

// each press of the Plan switch stored the whole Plan contract as a message of the session, so
// pressing it in a loop filled the context. The contract is now published when a prompt is sent, if it changed.
describe("plan-mode contract", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("stores one message per change the model sees, however often the switch is pressed", async () => {
		const harness = await createHarness({ extensionFactories: [{ name: "plan", factory: planModeExtension }] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		const bridge = planBridge();
		if (!bridge) throw new Error("the plan extension did not publish its toggle");
		const ctx = harness.session.extensionRunner.createContext();
		const press = async (times: number) => {
			for (let i = 0; i < times; i++) await bridge.toggle(ctx);
		};
		const contracts = () =>
			harness.session.messages.flatMap((message) =>
				message.role === "custom" && message.customType === "plan-mode-transition"
					? [(message.details as { mode: string }).mode]
					: [],
			);

		await press(7);
		expect(contracts()).toEqual([]);

		harness.setResponses([fauxAssistantMessage("planned")]);
		await harness.session.prompt("go");
		expect(contracts()).toEqual(["plan"]);

		// Back to the same mode: nothing new to tell the model.
		await press(6);
		harness.setResponses([fauxAssistantMessage("still planning")]);
		await harness.session.prompt("again");
		expect(contracts()).toEqual(["plan"]);

		await press(1);
		expect(contracts()).toEqual(["plan"]);
		harness.setResponses([fauxAssistantMessage("back")]);
		await harness.session.prompt("now normal");
		expect(contracts()).toEqual(["plan", "normal"]);
	});

	// Plan mode turned on then off in an empty session still gave the model a
	// Normal contract about a Plan mode it never saw, and the model called plan_mode_complete in a loop.
	it("leaves nothing for the model when Plan mode is turned on then off before any prompt", async () => {
		const harness = await createHarness({ extensionFactories: [{ name: "plan", factory: planModeExtension }] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		const bridge = planBridge();
		if (!bridge) throw new Error("the plan extension did not publish its toggle");
		const ctx = harness.session.extensionRunner.createContext();
		await bridge.toggle(ctx);
		await bridge.toggle(ctx);
		let seen = "";
		harness.setResponses([
			(context) => {
				seen = JSON.stringify(context.messages);
				return fauxAssistantMessage("hello");
			},
		]);
		await harness.session.prompt("hi");
		expect(seen).toContain("hi");
		expect(seen).not.toContain("PLAN MODE CONTRACT");
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
	});
});

// fork: the plan module left its bridge published after its shutdown.
// Disabled then reloaded, it was gone, yet /init offered to plan first and toggle_plan answered toggled: true
// through the unloaded instance.
describe("plan-mode bridge lifetime", () => {
	const harnesses: Harness[] = [];
	const PLAN_BRIDGE = Symbol.for("prism.plan-mode");
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		delete (globalThis as Record<symbol, unknown>)[PLAN_BRIDGE];
	});

	const loaded = async () => {
		const harness = await createHarness({ extensionFactories: [{ name: "plan", factory: planModeExtension }] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		expect(planBridge()).toBeDefined();
		return harness;
	};

	it("removes its bridge when it shuts down", async () => {
		const harness = await loaded();
		await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "reload" });
		expect(planBridge()).toBeUndefined();
	});

	it("keeps the bridge a newer instance published", async () => {
		const harness = await loaded();
		const newer = { toggle: () => {}, enabled: () => false };
		(globalThis as Record<symbol, unknown>)[PLAN_BRIDGE] = newer;
		await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "reload" });
		expect(planBridge()).toBe(newer);
	});
});
