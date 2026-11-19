// Fake language server for fork-lsp-fuzz.test.ts. It answers every lsp_fix with one source.fixAll action whose
// edits are read from FAKE_LSP_EDITS_FILE, and pads its initialize answer with FAKE_LSP_PAD bytes, sent in 64 KiB
// chunks, to test reading a large message.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// fork: a server that runs project code at start, as rust-analyzer runs build.rs.
// It tries to leave a witness in each path of FAKE_LSP_WITNESSES (separated by ":"); where the sandbox forbids a
// write, the witness is missing.
for (const witness of (process.env.FAKE_LSP_WITNESSES ?? "").split(":").filter(Boolean)) {
	try {
		writeFileSync(witness, "ran\n");
	} catch {}
}

let buffer = Buffer.alloc(0);
// like a conforming server, answer with bare Commands unless the client announced
// CodeAction literals. A file named like the edits file plus ".commands" forces Commands anyway.
let literalSupport = false;

function send(message) {
	const body = Buffer.from(JSON.stringify(message));
	const all = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
	for (let offset = 0; offset < all.length; offset += 65_536) process.stdout.write(all.subarray(offset, offset + 65_536));
}

function answer(message) {
	switch (message.method) {
		case "initialize":
			literalSupport = message.params?.capabilities?.textDocument?.codeAction?.codeActionLiteralSupport !== undefined;
			return {
				capabilities: { diagnosticProvider: {}, codeActionProvider: true },
				pad: "x".repeat(Number(process.env.FAKE_LSP_PAD ?? 0)),
			};
		case "textDocument/diagnostic":
			return { kind: "full", items: [] };
		case "textDocument/codeAction": {
			const edits = JSON.parse(readFileSync(process.env.FAKE_LSP_EDITS_FILE, "utf8"));
			const uri = message.params.textDocument.uri;
			// a file named like the edits file plus ".change" holds a text the document
			// takes while the server answers, as an edit made during the analysis would.
			const change = `${process.env.FAKE_LSP_EDITS_FILE}.change`;
			if (existsSync(change)) {
				writeFileSync(fileURLToPath(uri), readFileSync(change, "utf8"));
				rmSync(change);
			}
			const commands = `${process.env.FAKE_LSP_EDITS_FILE}.commands`;
			if (!literalSupport || existsSync(commands)) {
				rmSync(commands, { force: true });
				return [{ title: "fix all", command: "fake.fixAll", arguments: [uri] }];
			}
			return [{ title: "fix all", kind: "source.fixAll", edit: { changes: { [uri]: edits } } }];
		}
		default:
			return null;
	}
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const separator = buffer.indexOf("\r\n\r\n");
		if (separator < 0) return;
		const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, separator).toString())[1]);
		if (buffer.length < separator + 4 + length) return;
		const message = JSON.parse(buffer.subarray(separator + 4, separator + 4 + length).toString());
		buffer = buffer.subarray(separator + 4 + length);
		if (message.method === "exit") process.exit(0);
		if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: answer(message) });
	}
});
