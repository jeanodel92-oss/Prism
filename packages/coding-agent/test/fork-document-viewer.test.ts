import { execFileSync } from "node:child_process";
import {
	accessSync,
	chmodSync,
	closeSync,
	constants,
	existsSync,
	mkdtempSync,
	openSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	getKeybindings,
	KeybindingsManager,
	setCapabilities,
	setKeybindings,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DocumentPreview,
	EXTRACTION_MEMORY_BYTES,
	previewDocument,
	type Runner,
} from "../src/fork/document-preview.ts";
import { DocumentViewer } from "../src/fork/document-viewer.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { smallPdf } from "./fork-pdf-fixture.ts";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
	"base64",
);

let dir: string;

/** Every program found in /usr/bin, bubblewrap included. */
const system = (name: string) => `/usr/bin/${name}`;

function realpathOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function onPath(name: string): string | undefined {
	return (process.env.PATH ?? "")
		.split(":")
		.map((directory) => resolve(directory, name))
		.find((path) => {
			try {
				accessSync(path, constants.X_OK);
				return statSync(path).isFile();
			} catch {
				return false;
			}
		});
}

function starts(bwrap: string): boolean {
	try {
		execFileSync(bwrap, ["--ro-bind", "/", "/", "--unshare-all", "true"], { stdio: "ignore", timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

/** The adapter's command line inside the one bubblewrap call. */
/** The file bubblewrap mounts at `inside`. */
function boundAt(run: ReturnType<typeof vi.fn<Runner>>, inside: string): string | undefined {
	const args = run.mock.calls[0]![1];
	const index = args.findIndex((arg, i) => arg === "--ro-bind" && args[i + 2] === inside);
	return index < 0 ? undefined : args[index + 1];
}

function adapterCall(run: ReturnType<typeof vi.fn<Runner>>): string[] {
	expect(run).toHaveBeenCalledTimes(1);
	const [program, args] = run.mock.calls[0]!;
	expect(program).toBe("/usr/bin/bwrap");
	return args.slice(args.indexOf("--") + 1);
}

function file(name: string, content: string | Buffer): string {
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

beforeAll(() => initTheme("dark"));
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "prism-document-"));
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
});
afterEach(() => {
	setLanguage("en");
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("document preview", () => {
	it.each([
		["plain.txt", "hello\nworld", "text"],
		["readme.md", "# Hello", "markdown"],
		["readme.markdown", "# Hello", "markdown"],
		["data.csv", 'name,value\n"Doe, Jane",42', "csv"],
		["data.tsv", "name\tvalue\nJane\t42", "csv"],
	])("reads %s", async (name, text, kind) => {
		const path = file(name, text);
		expect(await previewDocument(path)).toMatchObject({
			path: realpathSync(path),
			kind,
			text,
			size: Buffer.byteLength(text),
		});
	});

	it("recognizes PNG content before its extension and preserves its bytes", async () => {
		const preview = await previewDocument(file("picture.md", PNG));
		expect(preview).toMatchObject({
			kind: "image",
			type: "PNG image",
			image: { mimeType: "image/png", data: PNG.toString("base64") },
		});
	});

	it("caps text at 4 MiB and reports its actual size", async () => {
		const length = 4 * 1024 * 1024 + 13;
		const preview = await previewDocument(file("large.txt", Buffer.alloc(length, 65)));
		expect(preview.text?.length).toBe(4 * 1024 * 1024);
		expect(preview.size).toBe(length);
		expect(preview.note).toContain(String(length));
		expect(preview.note).toContain("truncated");
	});

	it("omits images above 20 MiB", async () => {
		const content = Buffer.alloc(20 * 1024 * 1024 + 1);
		PNG.copy(content);
		const preview = await previewDocument(file("large.png", content));
		expect(preview).toMatchObject({ kind: "image", size: content.length });
		expect(preview.image).toBeUndefined();
		expect(preview.note).toContain("20 MiB");
	});

	it("does not start the runner when pdftotext is missing", async () => {
		const run = vi.fn<Runner>();
		const preview = await previewDocument(file("report.bin", smallPdf()), { which: () => undefined, run });
		expect(preview.kind).toBe("extracted");
		expect(preview.type).toBe("PDF document");
		expect(preview.problem).toContain("pdftotext");
		expect(preview.problem).toContain("poppler-utils");
		expect(preview.text).toBeUndefined();
		expect(run).not.toHaveBeenCalled();
	});

	it("looks for adapters on the current PATH only when a document needs one", async () => {
		vi.stubEnv("PATH", dir);
		const run = vi.fn<Runner>().mockResolvedValue("found on PATH");
		const path = file("on-demand.pdf", smallPdf());
		expect((await previewDocument(path, { run })).problem).toContain("poppler-utils");
		expect(run).not.toHaveBeenCalled();
		file("pdftotext", "placeholder");
		chmodSync(join(dir, "pdftotext"), 0o755);
		expect((await previewDocument(path, { run })).problem).toContain("bubblewrap");
		expect(run).not.toHaveBeenCalled();
		file("bwrap", "placeholder");
		chmodSync(join(dir, "bwrap"), 0o755);
		expect((await previewDocument(path, { run })).text).toBe("found on PATH");
		expect(run).toHaveBeenCalledWith(
			join(dir, "bwrap"),
			expect.arrayContaining([realpathSync(join(dir, "pdftotext")), realpathSync(path)]),
			expect.any(Object),
		);
	});

	it("extracts a real PDF with installed pdftotext", async (context) => {
		const program = onPath("pdftotext");
		if (!program || !onPath("bwrap")) {
			context.skip("pdftotext (poppler-utils) or bubblewrap is not installed");
			return;
		}
		const path = file("real.pdf", smallPdf());
		const preview = await previewDocument(path);
		expect(preview.problem).toBeUndefined();
		expect(preview.text).toContain("Hello Prism");
		expect(preview.note).toContain("pdftotext");
	});

	it.each(["docx", "odt"])("requires ZIP magic before starting pandoc for %s", async (extension) => {
		const run = vi.fn<Runner>();
		const which = vi.fn(() => "/usr/bin/pandoc");
		const preview = await previewDocument(file(`fake.${extension}`, "not a ZIP"), { which, run });
		expect(preview.kind).toBe("unsupported");
		expect(preview.type).toBe("binary file");
		expect(run).not.toHaveBeenCalled();
		expect(which).not.toHaveBeenCalled();
	});

	it.each(["docx", "odt"])("extracts ZIP-backed %s with pandoc only on demand", async (extension) => {
		const path = file(`real.${extension}`, Buffer.from([0x50, 0x4b, 3, 4, 0, 0]));
		const run = vi.fn<Runner>().mockResolvedValue("Document body");
		const extracted = await previewDocument(path, { which: system, run });
		expect(extracted.text).toBe("Document body");
		expect(extracted.note).toBe("Text extracted by pandoc; layout is lost.");
		// the document is shown at a fixed place; the real file is what is mounted there.
		const inside = `/input/document.${extension}`;
		expect(adapterCall(run)).toEqual([realpathOr("/usr/bin/pandoc"), "-t", "plain", inside]);
		expect(boundAt(run, inside)).toBe(realpathSync(path));
		const missing = await previewDocument(path, { which: () => undefined, run });
		expect(missing.problem).toContain("pandoc");
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("recognizes binary and unknown ZIP files without looking up programs", async () => {
		const which = vi.fn(() => undefined);
		for (const content of [Buffer.from([1, 2, 0, 4]), Buffer.from([0x50, 0x4b, 3, 4])]) {
			expect((await previewDocument(file("unknown.bin", content), { which })).kind).toBe("unsupported");
		}
		expect(which).not.toHaveBeenCalled();
	});

	it("refuses missing files, directories and devices", async () => {
		for (const path of [join(dir, "absent.txt"), dir, "/dev/null"]) {
			expect((await previewDocument(path)).kind).toBe("missing");
		}
	});

	it("refuses a FIFO without opening it", async (context) => {
		const path = join(dir, "pipe");
		try {
			execFileSync("mkfifo", [path], { timeout: 1000 });
		} catch {
			// Some sandboxes reject spawnSync's wait even after mkfifo created the pipe.
			if (!existsSync(path) || !statSync(path).isFIFO()) {
				context.skip("mkfifo is unavailable or blocked by the sandbox");
				return;
			}
		}
		expect((await previewDocument(path)).kind).toBe("missing");
	}, 2000);

	it("passes an absolute real path for -rf.pdf and follows symlinks", async () => {
		const path = file("-rf.pdf", smallPdf());
		const link = join(dir, "link.pdf");
		symlinkSync(path, link);
		const run = vi.fn<Runner>().mockResolvedValue("safe text");
		const preview = await previewDocument(link, { which: system, run });
		expect(isAbsolute(preview.path)).toBe(true);
		expect(adapterCall(run)).toEqual([
			realpathOr("/usr/bin/pdftotext"),
			"-layout",
			"-enc",
			"UTF-8",
			"/input/document.pdf",
			"-",
		]);
		expect(boundAt(run, "/input/document.pdf")).toBe(realpathSync(path));
		expect(run.mock.calls[0]![2]).toEqual({
			timeout: 15000,
			maxBuffer: 16 * 1024 * 1024,
			memoryBytes: EXTRACTION_MEMORY_BYTES,
		});
	});

	it("shows the adapter /usr and the document only, with no network or environment", async () => {
		const path = file("sandbox.pdf", smallPdf());
		const run = vi.fn<Runner>().mockResolvedValue("sandbox text");
		await previewDocument(path, { which: system, run });
		const args = run.mock.calls[0]![1];
		const binds = args.flatMap((arg, i) => (arg === "--ro-bind" ? [args[i + 1]] : []));
		expect(binds[0]).toBe("/usr");
		expect(binds).not.toContain("/");
		expect(binds).not.toContain("/etc");
		expect(binds).toContain(realpathSync(path));
		expect(args).toEqual(expect.arrayContaining(["--unshare-all", "--clearenv", "--die-with-parent"]));
		expect(adapterCall(run)[0]).toBe(realpathOr("/usr/bin/pdftotext"));
	});

	it("never runs an adapter without bubblewrap", async () => {
		const run = vi.fn<Runner>();
		const preview = await previewDocument(file("alone.pdf", smallPdf()), {
			which: (name) => (name === "bwrap" ? undefined : system(name)),
			run,
		});
		expect(preview.problem).toContain("Install bubblewrap");
		expect(preview.text).toBeUndefined();
		expect(run).not.toHaveBeenCalled();
	});

	it("says when bubblewrap itself is refused", async () => {
		// As on Ubuntu 24.04 without an AppArmor profile for bubblewrap.
		const bwrap = file("bwrap", '#!/bin/sh\necho "bwrap: setting up uid map: Permission denied" >&2\nexit 1\n');
		chmodSync(bwrap, 0o755);
		const preview = await previewDocument(file("refused.pdf", smallPdf()), {
			which: (name) => (name === "bwrap" ? bwrap : system(name)),
		});
		expect(preview.problem).toContain("The isolation (bubblewrap) could not start: setting up uid map");
		expect(preview.problem).toContain("/settings");
		expect(preview.text).toBeUndefined();
	});

	it("hides other files, the system's configuration and the environment from a real adapter", async (context) => {
		const bwrap = onPath("bwrap");
		if (!bwrap || !starts(bwrap)) {
			context.skip("bubblewrap is not installed or cannot start here");
			return;
		}
		const secret = file("secret.txt", "sibling-secret");
		const written = join(dir, "written");
		const adapter = file(
			"pdftotext",
			[
				"#!/bin/sh",
				`cat '${secret}' 2>/dev/null || echo "sibling: hidden"`,
				`cat /etc/passwd >/dev/null 2>&1 && echo "etc: visible" || echo "etc: hidden"`,
				`ls /home >/dev/null 2>&1 && echo "home: visible" || echo "home: hidden"`,
				`echo "env: \${PRISM_TEST_SECRET:-hidden}"`,
				`touch '${written}' 2>/dev/null`,
				"",
			].join("\n"),
		);
		chmodSync(adapter, 0o755);
		vi.stubEnv("PRISM_TEST_SECRET", "env-secret");
		// The same program, run directly, sees all of it.
		expect(execFileSync(adapter, { encoding: "utf8" })).toBe(
			"sibling-secret" + "etc: visible\nhome: visible\nenv: env-secret\n",
		);
		rmSync(written);
		const preview = await previewDocument(file("doc.pdf", smallPdf()), {
			which: (name) => (name === "bwrap" ? bwrap : adapter),
		});
		expect(preview.problem).toBeUndefined();
		expect(preview.text).toBe("sibling: hidden\netc: hidden\nhome: hidden\nenv: hidden\n");
		expect(existsSync(written)).toBe(false);
	});

	// fork: bubblewrap 0.9 (Ubuntu 24.04) has no --ro-bind-fd; the descriptor is still
	// what it mounts, so a file put under the name meanwhile is not read.
	it("extracts through a descriptor with a bubblewrap older than 0.10", async (context) => {
		const real = onPath("bwrap");
		const pdftotext = onPath("pdftotext");
		if (!real || !starts(real) || !pdftotext) {
			context.skip("bubblewrap or pdftotext is missing, or bubblewrap cannot start here");
			return;
		}
		const old = file(
			"bwrap",
			[
				"#!/bin/sh",
				'[ "$1" = --version ] && { echo "bubblewrap 0.9.0"; exit 0; }',
				'for arg; do [ "$arg" = --ro-bind-fd ] && { echo "bwrap: Unknown option --ro-bind-fd" >&2; exit 1; }; done',
				`exec '${real}' "$@"`,
				"",
			].join("\n"),
		);
		chmodSync(old, 0o755);
		const path = file("judged.pdf", smallPdf());
		const fd = openSync(path, "r");
		try {
			renameSync(path, join(dir, "moved.pdf"));
			file("judged.pdf", "%PDF-1.4 not the judged file");
			const preview = await previewDocument(`/proc/self/fd/${fd}`, {
				name: "judged.pdf",
				fd,
				which: (name) => (name === "bwrap" ? old : pdftotext),
			});
			expect(preview.problem).toBeUndefined();
			expect(preview.text).toContain("Hello Prism");
		} finally {
			closeSync(fd);
		}
	});

	// fork: a parser's memory is bounded, not only its output.
	it("bounds what a real adapter and its children may allocate, and refuses past it", async (context) => {
		const bwrap = onPath("bwrap");
		if (!bwrap || !starts(bwrap) || !existsSync("/usr/bin/awk")) {
			context.skip("bubblewrap is not installed or cannot start here, or awk is missing");
			return;
		}
		const adapter = (name: string, body: string) => {
			const path = file(name, `#!/bin/sh\n${body}\n`);
			chmodSync(path, 0o755);
			return path;
		};
		const reports = adapter("pdftotext", 'echo "limit $(ulimit -d)"');
		const preview = await previewDocument(file("doc.pdf", smallPdf()), {
			which: (name) => (name === "bwrap" ? bwrap : reports),
		});
		expect(preview.text).toBe(`limit ${EXTRACTION_MEMORY_BYTES / 1024}\n`);
		// A child that builds a 1 GiB string; without the limit it ends and prints.
		const greedy = adapter(
			"pandoc",
			`/usr/bin/awk 'BEGIN { s = "x"; while (length(s) < 1073741824) s = s s; print "survived" }'`,
		);
		const docx = file("big.docx", Buffer.from("PK\u0003\u0004"));
		const refused = await previewDocument(docx, { which: (name) => (name === "bwrap" ? bwrap : greedy) });
		expect(refused.text).toBeUndefined();
		expect(refused.problem).toContain("memory limit");
	}, 30_000);

	it("runs at most two extractions at once", async () => {
		let running = 0;
		let most = 0;
		const run = vi.fn<Runner>(async () => {
			most = Math.max(most, ++running);
			await new Promise((resolve) => setTimeout(resolve, 50));
			running--;
			return "text";
		});
		const previews = await Promise.all(
			[1, 2, 3, 4, 5].map((n) => previewDocument(file(`doc-${n}.pdf`, smallPdf()), { which: system, run })),
		);
		expect(previews.map((preview) => preview.text)).toEqual(["text", "text", "text", "text", "text"]);
		expect(run).toHaveBeenCalledTimes(5);
		expect(most).toBe(2);
	});

	it("shows an executable script as text without executing it", async () => {
		const marker = join(dir, "executed");
		const path = file("run.sh", `#!/bin/sh\ntouch '${marker}'\n`);
		chmodSync(path, 0o755);
		const run = vi.fn<Runner>();
		const preview = await previewDocument(path, { run });
		expect(preview.kind).toBe("text");
		expect(preview.text).toContain("touch");
		expect(existsSync(marker)).toBe(false);
		expect(run).not.toHaveBeenCalled();
	});

	it.each(["timeout", "output limit", "program error"])(
		"reports adapter %s without presenting partial text",
		async (reason) => {
			const preview = await previewDocument(file("failure.pdf", smallPdf()), {
				which: system,
				run: vi
					.fn<Runner>()
					.mockRejectedValue(Object.assign(new Error(reason), { stdout: "partial", killed: true })),
			});
			expect(preview.problem).toContain("pdftotext");
			expect(preview.problem).toContain("timeout");
			expect(preview.text).toBeUndefined();
		},
	);
});

function viewer(preview: DocumentPreview, height = 12) {
	const close = vi.fn();
	const render = vi.fn();
	const component = new DocumentViewer({ preview, height: () => height, onClose: close, requestRender: render });
	return { component, close, render };
}

function plain(component: DocumentViewer, width = 64): string[] {
	return component.render(width).map(stripTerminalSequences);
}

describe("document viewer", () => {
	it("wraps or truncates every kind at 40, 64 and 100 columns", async () => {
		const previews = await Promise.all([
			previewDocument(file("text.txt", "wide 界 ".repeat(80))),
			previewDocument(
				file("text.md", `# Title\n\n${"markdown ".repeat(80)}\n\n| a | b |\n| --- | --- |\n| x | y |`),
			),
			previewDocument(file("data.csv", 'name,value\n"Doe, Jane",42\n"quote ""inside""",3\n"two\nlines",4')),
			previewDocument(file("image.png", PNG)),
			previewDocument(file("unknown", Buffer.from([0]))),
			previewDocument(join(dir, "absent")),
			previewDocument(file("pdf.pdf", smallPdf()), { which: () => undefined }),
		]);
		previews.push({
			path: join(dir, "extracted.pdf"),
			kind: "extracted",
			type: "PDF document",
			text: "body ".repeat(90),
			note: "Text extracted by pdftotext; layout is lost.",
		});
		for (const preview of previews) {
			const { component } = viewer(preview);
			for (const width of [40, 64, 100]) {
				const lines = component.render(width);
				expect(lines).toHaveLength(12);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		const { component } = viewer(previews[2]!);
		expect(plain(component).join("\n")).toMatch(/Doe, Jane +│ 42/);
		expect(plain(component).join("\n")).toContain('quote "inside"');
		expect(plain(component).join("\n")).toContain("two ↵ lines");
	});

	it("uses the image component in a capable terminal at every requested width", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const { component } = viewer(await previewDocument(file("image.png", PNG)));
		for (const width of [40, 64, 100]) {
			const lines = component.render(width);
			expect(lines.join("\n")).toContain("\x1b_G");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("finds the first match, Enter jumps to the second, and Esc clears then closes", () => {
		const text = [
			"first needle",
			...Array.from({ length: 12 }, (_, i) => `line ${i}`),
			"second needle",
			...Array(12).fill("tail"),
		].join("\n");
		const { component, close } = viewer({ path: "/document.txt", kind: "text", type: "Text file", text });
		component.render(64);
		component.handleInput("needle");
		expect(plain(component)[3]).toBe("first needle");
		expect(plain(component).join("\n")).toContain("match 1/2");
		component.handleInput("\r");
		expect(plain(component)[3]).toBe("second needle");
		expect(plain(component).join("\n")).toContain("match 2/2");
		component.handleInput("\x1b");
		expect(close).not.toHaveBeenCalled();
		expect(plain(component).join("\n")).not.toContain("match 2/2");
		component.handleInput("\x1b");
		expect(close).toHaveBeenCalledOnce();
	});

	it("edits search, reports no match and counts occurrences on the same row", () => {
		const { component } = viewer({ path: "/text", kind: "text", type: "Text file", text: "cat cat" });
		component.render(64);
		component.handleInput("cat");
		expect(plain(component).join("\n")).toContain("match 1/2");
		component.handleInput("x");
		expect(plain(component).join("\n")).toContain("no match");
		component.handleInput("\x7f");
		expect(plain(component).join("\n")).toContain("match 1/2");
	});

	it("scrolls by keys, pages, home/end and one line per wheel notch", () => {
		const { component } = viewer({
			path: "/text",
			kind: "text",
			type: "Text file",
			text: Array.from({ length: 40 }, (_, i) => `row ${i}`).join("\n"),
		});
		expect(plain(component)[3]).toBe("row 0");
		component.handleInput("\x1b[B");
		expect(plain(component)[3]).toBe("row 1");
		component.handleMouse({
			type: "wheel",
			button: "none",
			x: 0,
			y: 4,
			screenX: 0,
			screenY: 4,
			width: 64,
			height: 12,
			shift: false,
			alt: false,
			ctrl: false,
			wheelDelta: 3,
		});
		expect(plain(component)[3]).toBe("row 2");
		component.handleInput("\x1b[6~");
		expect(plain(component)[3]).toBe("row 9");
		component.handleInput("\x1b[5~");
		expect(plain(component)[3]).toBe("row 2");
		component.handleInput("\x1b[F");
		expect(plain(component)[3]).toBe("row 33");
		component.handleInput("\x1b[H");
		expect(plain(component)[3]).toBe("row 0");
	});

	it("uses configured selection keys", () => {
		const original = getKeybindings();
		try {
			setKeybindings(
				new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "ctrl+q", "tui.select.confirm": "ctrl+n" }),
			);
			const { component, close } = viewer({ path: "/text", kind: "text", type: "Text file", text: "cat cat" });
			component.render(64);
			component.handleInput("cat");
			component.handleInput("\x0e");
			expect(plain(component).join("\n")).toContain("match 2/2");
			component.handleInput("\x11");
			expect(close).not.toHaveBeenCalled();
			component.handleInput("\x11");
			expect(close).toHaveBeenCalledOnce();
		} finally {
			setKeybindings(original);
		}
	});

	it("removes terminal controls from names, paths and document content", () => {
		const { component } = viewer({
			path: "/tmp/evil\x1b[2J.txt",
			kind: "text",
			type: "Text file",
			text: "safe\x1b[2J\x1b]52;c;secret\x07\x00\x08\x9b",
		});
		const lines = component.render(64);
		expect(lines.join("\n")).not.toContain("\x1b[2J");
		expect(lines.join("\n")).not.toContain("secret");
		expect(plain(component)[3]).toBe("safe");
	});

	it("renders image fallback dimensions and translated problems, notes and search", async () => {
		setLanguage("fr");
		const image = viewer(await previewDocument(file("image.png", PNG))).component;
		expect(plain(image).join("\n")).toContain("Image PNG");
		expect(plain(image).join("\n")).toContain("Dimensions : 1 × 1 px");
		const missing = viewer(await previewDocument(file("pdf.pdf", smallPdf()), { which: () => undefined })).component;
		expect(plain(missing).join("\n")).toContain("Installez poppler-utils");
		const { component } = viewer({
			path: "/text.pdf",
			kind: "extracted",
			type: "PDF document",
			text: "bonjour",
			note: "Text extracted by pdftotext; layout is lost.",
			size: 18,
		});
		expect(plain(component).join("\n")).toContain("Texte extrait par pdftotext");
		expect(plain(component).join("\n")).toContain("18 octets");
		component.handleInput("bonjour");
		expect(plain(component).join("\n")).toContain("résultat 1/1");
		component.handleInput("x");
		expect(plain(component).join("\n")).toContain("aucun résultat");
	});
});
