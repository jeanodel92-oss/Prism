/**
 * fork: `read` refuses binary files. It returned a .doc or .docx as raw bytes, 25 to
 * 50 KB of noise per call that a model cannot use; three such reads overflowed the context in plan mode
 *. Detection follows git: a NUL byte in the first 8000 bytes, plus PDF, whose
 * header can be followed by kilobytes of plain-text objects.
 */
import { open } from "node:fs/promises";

const SNIFF_BYTES = 8000;

/** Throws when the file at `absolutePath` looks binary. `path` is the path as the model wrote it. */
export async function assertNotBinaryFile(absolutePath: string, path: string): Promise<void> {
	const handle = await open(absolutePath, "r");
	let head: Buffer;
	try {
		const buffer = Buffer.alloc(SNIFF_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
		head = buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
	if (!head.includes(0) && !head.subarray(0, 5).equals(Buffer.from("%PDF-"))) return;
	throw new Error(
		`${path} is a binary file; its raw bytes are not shown. Extract its text with bash instead, for example antiword or catdoc for .doc, pandoc -t plain or unzip -p for .docx, pdftotext ${path} - for .pdf.`,
	);
}
