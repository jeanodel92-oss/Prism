/**
 * fork: what a file is and the text Prism can show of it, for the document viewer. Detection by
 * content first, then extension. PDF, .docx and .odt go through a system program found on demand (no new dependency)
 * , run without a shell, with the absolute path, a timeout and an
 * output cap, and only inside bubblewrap (never without isolation), which shows
 * it the system's programs, the document and nothing else. Nothing else is ever run: no OCR, no opening with
 * another application.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { constants, existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";
import { hostProgram } from "./host-program.ts";

export type PreviewKind = "text" | "markdown" | "csv" | "image" | "extracted" | "unsupported" | "missing";

export interface DocumentPreview {
	path: string;
	kind: PreviewKind;
	type: string;
	size?: number;
	text?: string;
	image?: { data: string; mimeType: string };
	note?: string;
	problem?: string;
}

export type Runner = (
	program: string,
	args: string[],
	/**
	 * `input`: a descriptor given to the program as its standard input. `memoryBytes`: the data it and what it starts
	 * may allocate (RLIMIT_DATA).
	 */
	options: { timeout: number; maxBuffer: number; memoryBytes: number; input?: number; signal?: AbortSignal },
) => Promise<string>;

export interface PreviewOptions {
	which?: (name: string) => string | undefined;
	run?: Runner;
	/**
	 * fork: the file's name, for its extension, when `path` is a descriptor already
	 * opened on the file a permission judged (`/proc/<pid>/fd/<n>`): read through it, never resolved to a name again.
	 */
	name?: string;
	/** That descriptor: the extraction's sandbox mounts the file from it (bubblewrap cannot open Prism's /proc). */
	fd?: number;
	/** fork: the read that asked for the text was cancelled; the program is stopped. */
	signal?: AbortSignal;
}

/** The top-level system folders, mirrored as the host has them (links into /usr, or folders). */
const SYSTEM_DIRS = ["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];

const TEXT_LIMIT = 4 * 1024 * 1024;
/** Also the largest image `read` and `@path` load. */
export const IMAGE_LIMIT = 20 * 1024 * 1024;

/**
 * fork: the data a document program may allocate, it and what it starts
 * (RLIMIT_DATA, which also holds pandoc's runtime), and how many run at once. A 300 KiB DOCX whose document.xml unpacks
 * to 100 MiB took pandoc 3.7 past 4 GiB; under this limit it fails at about 1.1 GiB. A 4 MiB document.xml needed
 * 580 MiB. The time limit and the output cap bound the rest, not the parser's memory.
 */
export const EXTRACTION_MEMORY_BYTES = 1024 * 1024 * 1024;
const MAX_EXTRACTIONS = 2;

/**
 * bubblewrap arguments that show the adapter /usr and its links, the dynamic linker's cache and the document:
 * no home, no other file, no network, no environment (API keys live there, and the text may go to the model).
 */
function isolationArgs(program: string, document: string | number, inside: string, bindFd: boolean): string[] {
	const args = ["--ro-bind", "/usr", "/usr"];
	for (const dir of SYSTEM_DIRS) {
		try {
			const stat = lstatSync(dir);
			if (stat.isSymbolicLink()) args.push("--symlink", readlinkSync(dir), dir);
			else if (stat.isDirectory()) args.push("--ro-bind", dir, dir);
		} catch {}
	}
	if (existsSync("/etc/ld.so.cache")) args.push("--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache");
	args.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");
	args.push("--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--chdir", "/");
	// A program installed outside /usr (~/.local/bin, /opt) is shown alone: what it needs beyond /usr is not.
	if (!program.startsWith("/usr/")) args.push("--ro-bind", program, program);
	// A descriptor is the program's standard input (fd 0), which bubblewrap mounts there. Before bubblewrap 0.10, which
	// has no --ro-bind-fd, it mounts /proc/self/fd/0, its own standard input: the kernel follows that link to the file
	// the descriptor holds open, not to the name it had.
	if (typeof document === "number") args.push(...(bindFd ? ["--ro-bind-fd", "0"] : ["--ro-bind", "/proc/self/fd/0"]));
	else args.push("--ro-bind", document);
	args.push(inside);
	args.push("--", program);
	return args;
}

/**
 * `program` under the memory limit: a fixed /bin/sh script sets it and executes the program in its place (Node has
 * no setrlimit). Lowering a limit is always allowed; when the hard limit is already lower, it stays.
 */
function limited(program: string, args: string[], memoryBytes: number): [string, string[]] {
	const kib = String(Math.floor(memoryBytes / 1024));
	return ["/bin/sh", ["-c", 'ulimit -d "$1" 2>/dev/null; shift; exec "$@"', "sh", kib, program, ...args]];
}

const run: Runner = (adapter, adapterArgs, { input, memoryBytes, ...limits }) =>
	new Promise((resolve, reject) => {
		const [program, args] = limited(adapter, adapterArgs, memoryBytes);
		if (input === undefined) {
			const child = execFile(
				program,
				args,
				{ ...limits, encoding: "utf8", killSignal: "SIGKILL" },
				(error, stdout, stderr) => {
					// stderr says whether bubblewrap itself failed.
					if (error) reject(Object.assign(error, { stderr }));
					else resolve(stdout);
				},
			);
			// execFile creates a pipe; close it immediately so the adapter cannot read input.
			child.stdin?.destroy();
			return;
		}
		// fork: the document as standard input, which execFile cannot give.
		const { signal, ...spawnLimits } = limits;
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}
		const child = spawn(program, args, { stdio: [input, "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const fail = (error: Error) => {
			child.kill("SIGKILL");
			reject(Object.assign(error, { stderr }));
		};
		const timer = setTimeout(() => fail(new Error(`${adapter} timed out`)), spawnLimits.timeout);
		const onAbort = () => fail(new Error("Operation aborted"));
		signal?.addEventListener("abort", onAbort, { once: true });
		child.on("close", () => signal?.removeEventListener("abort", onAbort));
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
			if (stdout.length > spawnLimits.maxBuffer) fail(new Error("stdout maxBuffer length exceeded"));
		});
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(Object.assign(error, { stderr }));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(stdout);
			else reject(Object.assign(new Error(`${adapter} exited with code ${code}`), { stderr }));
		});
	});

async function inspectDocument(input: string, name?: string): Promise<DocumentPreview> {
	let path = resolve(input);
	try {
		if (name === undefined) path = await realpath(path);
		const info = await stat(path);
		if (!info.isFile()) return { path, kind: "missing", type: "Not a regular file" };
		const base = { path, size: info.size };
		// O_NONBLOCK also prevents a FIFO swapped in between stat and open from hanging.
		// A descriptor's path (`name` given) is a link to the file already opened: followed, it is that file.
		const file = await open(
			path,
			constants.O_RDONLY | constants.O_NONBLOCK | (name === undefined ? constants.O_NOFOLLOW : 0),
		);
		try {
			if (!(await file.stat()).isFile()) return { path, kind: "missing", type: "Not a regular file" };
			const prefix = Buffer.alloc(Math.min(info.size, 8000));
			const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
			const head = prefix.subarray(0, bytesRead);
			const extension = extname(name ?? path).toLowerCase();
			const mimeType = await detectSupportedImageMimeTypeFromFile(path);
			if (mimeType) {
				const preview: DocumentPreview = {
					...base,
					kind: "image",
					type: `${mimeType.slice(6).toUpperCase()} image`,
				};
				if (info.size > IMAGE_LIMIT) preview.note = "Image exceeds 20 MiB; preview omitted.";
				else {
					const buffer = Buffer.alloc(info.size);
					let length = 0;
					while (length < buffer.length) {
						const read = await file.read(buffer, length, buffer.length - length, length);
						if (!read.bytesRead) break;
						length += read.bytesRead;
					}
					preview.image = { data: buffer.subarray(0, length).toString("base64"), mimeType };
				}
				return preview;
			}
			if (head.subarray(0, 5).toString() === "%PDF-") return { ...base, kind: "extracted", type: "PDF document" };
			const zip = ["504b0304", "504b0506", "504b0708"].includes(head.subarray(0, 4).toString("hex"));
			if (zip && (extension === ".docx" || extension === ".odt")) {
				return { ...base, kind: "extracted", type: extension === ".docx" ? "DOCX document" : "ODT document" };
			}
			if (zip || head.includes(0) || extension === ".docx" || extension === ".odt") {
				return { ...base, kind: "unsupported", type: "binary file" };
			}
			const buffer = Buffer.alloc(Math.min(info.size, TEXT_LIMIT));
			head.copy(buffer);
			let length = head.length;
			while (length < buffer.length) {
				const read = await file.read(buffer, length, buffer.length - length, length);
				if (!read.bytesRead) break;
				length += read.bytesRead;
			}
			const kind = [".md", ".markdown"].includes(extension)
				? "markdown"
				: [".csv", ".tsv"].includes(extension)
					? "csv"
					: "text";
			return {
				...base,
				kind,
				type:
					kind === "markdown"
						? "Markdown"
						: kind === "csv"
							? extension === ".tsv"
								? "TSV table"
								: "CSV table"
							: "Text file",
				text: buffer.subarray(0, length).toString("utf8"),
				note: info.size > TEXT_LIMIT ? `File truncated to 4 MiB; full size: ${info.size} bytes.` : undefined,
			};
		} finally {
			await file.close();
		}
	} catch {
		return { path, kind: "missing", type: "Unavailable file", problem: "File is missing or cannot be read." };
	}
}

const bindsFd = new Map<string, boolean>();

/**
 * fork: whether this bubblewrap has --ro-bind-fd (0.10 and later; Ubuntu 24.04 ships 0.9).
 * Asked once per program; an answer it does not give counts as no.
 */
function bubblewrapBindsFd(bwrap: string): boolean {
	let known = bindsFd.get(bwrap);
	if (known === undefined) {
		try {
			const version = /(\d+)\.(\d+)/.exec(execFileSync(bwrap, ["--version"], { encoding: "utf8", timeout: 5000 }));
			known = version !== null && (Number(version[1]) > 0 || Number(version[2]) >= 10);
		} catch {
			known = false;
		}
		bindsFd.set(bwrap, known);
	}
	return known;
}

let extracting = 0;
const waitingExtractions: Array<() => void> = [];

/** Runs `task` once fewer than MAX_EXTRACTIONS others run (rapid previews in the file screen add up). */
async function inExtractionSlot<T>(task: () => Promise<T>): Promise<T> {
	if (extracting < MAX_EXTRACTIONS) extracting++;
	else await new Promise<void>((resolve) => waitingExtractions.push(resolve));
	try {
		return await task();
	} finally {
		// The slot goes to the next waiting extraction, if any.
		const next = waitingExtractions.shift();
		if (next) next();
		else extracting--;
	}
}

async function extractPreview(
	preview: DocumentPreview,
	options: PreviewOptions,
): Promise<{ text: string; adapter: string } | { problem: string }> {
	const adapter = preview.type === "PDF document" ? "pdftotext" : "pandoc";
	try {
		// fork: bubblewrap and the adapter run on the host first: never from where the
		// sandbox writes.
		const lookup = options.which ?? ((name: string) => hostProgram(name));
		const program = lookup(adapter);
		if (!program) {
			return {
				problem: `Install ${adapter === "pdftotext" ? "poppler-utils" : "pandoc"} (${adapter}) to read this document.`,
			};
		}
		const bwrap = lookup("bwrap");
		if (!bwrap) {
			return {
				problem:
					"Install bubblewrap (bwrap) to read this document: Prism runs document programs only in isolation.",
			};
		}
		const real = realpathOr(program);
		// The document is shown at a fixed place: its path may be a descriptor of Prism's (`/proc/<pid>/fd/<n>`).
		const inside = `/input/document.${preview.type.split(" ")[0]!.toLowerCase()}`;
		const args = adapter === "pdftotext" ? ["-layout", "-enc", "UTF-8", inside, "-"] : ["-t", "plain", inside];
		const document = options.fd ?? preview.path;
		const bindFd = options.fd !== undefined && bubblewrapBindsFd(bwrap);
		const text = await inExtractionSlot(() =>
			(options.run ?? run)(bwrap, [...isolationArgs(real, document, inside, bindFd), ...args], {
				timeout: 15000,
				maxBuffer: 16 * 1024 * 1024,
				memoryBytes: EXTRACTION_MEMORY_BYTES,
				...(options.fd === undefined ? {} : { input: options.fd }),
				...(options.signal ? { signal: options.signal } : {}),
			}),
		);
		return { text, adapter };
	} catch (error) {
		// bubblewrap reports its own failures as "bwrap: …" (on Ubuntu 24.04, AppArmor refusing namespaces).
		const stderr = (error as { stderr?: unknown }).stderr;
		const refused = typeof stderr === "string" ? stderr.match(/^bwrap: (.*)$/m)?.[1] : undefined;
		if (refused) {
			return {
				problem: `The isolation (bubblewrap) could not start: ${refused}. Once bubblewrap is allowed (see Sandbox in /settings for how), try again.`,
			};
		}
		return {
			problem: `Text extraction by ${adapter} failed (timeout, memory limit, output limit or program error).`,
		};
	}
}

function realpathOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

export async function previewDocument(path: string, options: PreviewOptions = {}): Promise<DocumentPreview> {
	const preview = await inspectDocument(path, options.name);
	if (preview.kind !== "extracted") return preview;
	const result = await extractPreview(preview, options);
	return "problem" in result
		? { ...preview, problem: result.problem }
		: { ...preview, text: result.text, note: `Text extracted by ${result.adapter}; layout is lost.` };
}

/**
 * fork: what the `read` tool returns for a PDF, .docx or .odt, the text a system program
 * extracts with a note saying so; undefined for any other file or when extraction is not possible, so `read`
 * refuses it as before. Only the first bytes are read to decide, so other reads cost nothing more.
 */
export async function documentTextForModel(path: string, options: PreviewOptions = {}): Promise<string | undefined> {
	const head = Buffer.alloc(5);
	try {
		const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			await file.read(head, 0, 5, 0);
		} finally {
			await file.close();
		}
	} catch {
		return undefined;
	}
	const zip = head.subarray(0, 2).toString("latin1") === "PK";
	if (
		head.toString("latin1") !== "%PDF-" &&
		!(zip && [".docx", ".odt"].includes(extname(options.name ?? path).toLowerCase()))
	) {
		return undefined;
	}
	const preview = await previewDocument(path, options);
	if (preview.kind !== "extracted") return undefined;
	// fork.9 QA: a missing program was reported as "a binary file", with the advice to run that same program. A failed
	// extraction (damaged file) keeps that refusal, which suggests other ways to extract the text.
	if (preview.text === undefined) {
		if (preview.problem && !preview.problem.startsWith("Text extraction by"))
			throw new Error(`This ${preview.type} cannot be read as text. ${preview.problem}`);
		return undefined;
	}
	const adapter = preview.note?.match(/by (\S+);/)?.[1] ?? "a system program";
	return `[Text extracted from this ${preview.type} by ${adapter}: layout, images and scanned pages are not included.]\n\n${preview.text}`;
}
