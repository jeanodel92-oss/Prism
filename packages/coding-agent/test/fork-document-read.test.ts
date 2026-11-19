// fork: `read` gives the model the text of a PDF, .docx or .odt
// that a system program extracts, with a note saying so; without the program, the refusal names it.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { smallPdf } from "./fork-pdf-fixture.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./suite/harness.ts";

const installed = (program: string) => {
	try {
		execFileSync("sh", ["-c", `command -v ${program}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

describe("fork: read extracts documents", () => {
	const path = process.env.PATH;
	const harnesses: Harness[] = [];
	afterEach(() => {
		process.env.PATH = path;
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function read(name: string, content: string | Buffer) {
		const harness = await createHarness();
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, name), content);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: name })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("read it");
		const result = getToolResult(harness, "read");
		return { text: getMessageText(result), isError: result.isError };
	}

	it.skipIf(!installed("pdftotext"))("returns a PDF's extracted text with a note", async () => {
		const { text, isError } = await read("report.pdf", smallPdf());
		expect(isError).toBe(false);
		expect(text).toMatch(/^\[Text extracted from this PDF document by pdftotext: layout, images/);
		expect(text).toContain("Hello Prism");
	});

	// fork.9 QA: the refusal named no missing program and advised running pdftotext, which was the one missing.
	it("refuses a PDF when no program can extract it, naming the program to install", async () => {
		process.env.PATH = "";
		const { text, isError } = await read("report.pdf", smallPdf());
		expect(isError).toBe(true);
		expect(text).toBe(
			"This PDF document cannot be read as text. Install poppler-utils (pdftotext) to read this document.",
		);
	});

	it("refuses a .docx that is not a document, without running anything", async () => {
		const { text, isError } = await read("fake.docx", Buffer.from([0x00, 0x01, 0x02, 0x03]));
		expect(isError).toBe(true);
		expect(text).toContain("is a binary file");
	});

	it("reads a text file named .pdf as text", async () => {
		const { text, isError } = await read("notes.pdf", "plain notes\n");
		expect(isError).toBe(false);
		expect(text).toBe("plain notes\n");
	});
});
