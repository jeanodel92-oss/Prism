import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { homeRelative, relativeInside } from "../src/fork/path-within.ts";
import {
	archiveDestination,
	buildPortableExport,
	contextFiles,
	fileExclusion,
	MAX_FILE_BYTES,
	MAX_TOTAL_FILE_BYTES,
	MAX_TOTAL_SESSION_BYTES,
	portableExport,
	readProjectFile,
	sessionCountProblem,
	sessionsSizeProblem,
	writeArchiveFile,
	writtenFiles,
} from "../src/fork/portable-export.ts";

const CANARY = "sk-canary-0123456789abcdef";

describe("fork: /export-zip, the portable archive (CAP-02)", () => {
	let root: string;
	let cwd: string;
	let sessionDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-export-"));
		cwd = join(root, "project");
		sessionDir = join(root, "sessions");
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "AGENTS.md"), "# Rules\n");
		writeFileSync(join(cwd, "src", "app.ts"), `export const key = "${CANARY}";\n`);
		writeFileSync(join(cwd, ".env"), `API_KEY=${CANARY}\n`);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function session(id: string, text: string): SessionManager {
		const manager = SessionManager.create(cwd, sessionDir, { id });
		manager.appendMessage({ role: "user", content: text, timestamp: Date.parse("2026-10-28T10:00:00Z") });
		manager.appendMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Plan the change." },
				{ type: "text", text: `Using ${CANARY} as asked.` },
				{ type: "toolCall", id: "c1", name: "write", arguments: { path: "src/app.ts", content: "x" } },
				{ type: "toolCall", id: "c2", name: "edit", arguments: { path: ".env", edits: [] } },
				{ type: "toolCall", id: "c3", name: "write", arguments: { path: "/etc/elsewhere.conf", content: "y" } },
				{ type: "toolCall", id: "c4", name: "write", arguments: { path: "src/gone.ts", content: "z" } },
			],
			api: "openai-completions",
			provider: "faux",
			model: "faux-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.parse("2026-10-28T10:00:05Z"),
		});
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "c1",
			toolName: "write",
			content: [{ type: "text", text: "Wrote src/app.ts" }],
			isError: false,
			timestamp: Date.parse("2026-10-28T10:00:06Z"),
		});
		return manager;
	}

	// fork: the archive kept the summarised messages and the summary in
	// the session's order, without saying which messages the summary kept, while the guide said to drop all before it.
	it("says which messages a compaction kept, so the context can be rebuilt from the guide", () => {
		const manager = session("s3", "summarised");
		const kept = manager.appendMessage({ role: "user", content: "kept one", timestamp: 1 });
		manager.appendMessage({ role: "user", content: "kept two", timestamp: 1 });
		manager.appendCompaction("The first request was done.", kept, 1000);
		manager.appendMessage({ role: "user", content: "after", timestamp: 1 });
		const built = buildPortableExport({
			cwd,
			sessions: [{ path: manager.getSessionFile()!, id: "s3" }],
			files: [],
			secrets: new Map(),
		});
		const text = (name: string) => String(built.entries.find((entry) => entry.name.endsWith(name))!.data);
		const messages = JSON.parse(text("messages.json")) as Array<{
			role: string;
			keptFrom?: number;
			content: unknown;
		}>;
		const summary = messages.find((message) => message.role === "compaction_summary")!;
		expect(summary.keptFrom).toBe(3);
		expect(JSON.stringify(messages[3]!.content)).toContain("kept one");
		expect(messages.filter((message) => message.keptFrom !== undefined)).toHaveLength(1);
		expect(text("transcript.md")).toContain("Replaces messages 1 to 3 in the model's context; keeps those from 4.");
		const guide = text("IMPORT.md");
		expect(guide).toContain("then the messages from its `keptFrom` up to it");
		expect(guide).not.toContain("they are not in the archive");
	});

	it("offers the files the sessions wrote, never a credentials file or one outside the project", () => {
		const manager = session("s1", "first");
		const written = writtenFiles(manager.getBranch(), cwd);
		expect(written).toEqual([".env", "/etc/elsewhere.conf", "src/app.ts", "src/gone.ts"]);
		expect(fileExclusion(".env", cwd)).toBe("may hold credentials");
		expect(fileExclusion("/etc/elsewhere.conf", cwd)).toBe("outside the project folder");
		expect(fileExclusion("keys/server.pem", cwd)).toBe("may hold credentials");
		symlinkSync("/etc/hostname", join(cwd, "link"));
		expect(fileExclusion("link", cwd)).toBe("a symbolic link");
		expect(fileExclusion("src/app.ts", cwd)).toBeUndefined();
		expect(contextFiles(cwd)).toEqual(["AGENTS.md"]);
	});

	it("keeps a file whose name starts with two dots inside the project", () => {
		const entry = {
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", name: "write", arguments: { path: "..notes/todo.md" } }],
			},
		} as unknown as SessionEntry;
		expect(writtenFiles([entry], cwd)).toEqual(["..notes/todo.md"]);
		expect(fileExclusion("..notes/todo.md", cwd)).toBeUndefined();
		expect(relativeInside(cwd, join(cwd, "..notes"))).toBe("..notes");
		expect(relativeInside(cwd, join(cwd, "..", "other"))).toBeUndefined();
		expect(relativeInside(cwd, dirname(cwd))).toBeUndefined();
		expect(relativeInside(cwd, cwd)).toBeUndefined();
	});

	it("writes the home folder as ~ only for the home folder and what is below it", () => {
		expect(homeRelative("/home/al", "/home/al")).toBe("~");
		expect(homeRelative("/home/al/notes/a.md", "/home/al")).toBe("~/notes/a.md");
		expect(homeRelative("/home/alice/a.md", "/home/al")).toBe("/home/alice/a.md");
		expect(homeRelative("/etc/hosts", "/")).toBe("/etc/hosts");
		expect(homeRelative("/etc/hosts", "")).toBe("/etc/hosts");
	});

	it("writes a standard ZIP with only the chosen sessions and files, known secrets masked, a missing file marked", async () => {
		const first = session("s1", "first session");
		session("s2", "second session, not chosen");
		const built = buildPortableExport({
			cwd,
			sessions: [{ path: first.getSessionFile()!, id: "s1", name: "Fix the login" }],
			files: ["src/app.ts", "src/gone.ts", ".env"],
			secrets: new Map([[CANARY, "API_KEY"]]),
			now: new Date("2026-10-28T11:00:00Z"),
		});
		const zip = join(root, "out.zip");
		writeArchiveFile(zip, built.entries);

		// A standard tool opens it.
		execFileSync("unzip", ["-tq", zip]);
		const out = join(root, "unzipped");
		execFileSync("unzip", ["-q", zip, "-d", out]);
		const listing = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n").sort();
		expect(listing).toEqual([
			"IMPORT.md",
			"files/src/app.ts",
			"manifest.json",
			"sessions/01-s1/messages.json",
			"sessions/01-s1/transcript.md",
		]);

		// No known secret anywhere, and the masking is counted.
		for (const name of listing) expect(readFileSync(join(out, name), "utf8")).not.toContain(CANARY);
		expect(readFileSync(join(out, "files/src/app.ts"), "utf8")).toContain("[secret hidden: API_KEY]");
		// fork: counted once per occurrence in the data, no longer once per file it is copied to.
		expect(built.masked).toBe(2);

		// A fake agent with no history: only the archive, starting from IMPORT.md and the manifest it names.
		const guide = readFileSync(join(out, "IMPORT.md"), "utf8");
		expect(guide).toContain("manifest.json");
		expect(guide).toContain("personal or confidential data");
		const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
		expect(manifest).toMatchObject({
			format: "prism-portable-export",
			formatVersion: 1,
			createdAt: "2026-10-28T11:00:00.000Z",
			origin: { projectPath: cwd },
			secretsMasked: 2,
			analysedForPersonalData: false,
			guide: "IMPORT.md",
		});
		expect(manifest.sessions).toHaveLength(1);
		expect(manifest.sessions[0]).toMatchObject({
			id: "s1",
			name: "Fix the login",
			messageCount: 3,
			models: ["faux-model"],
		});
		expect(manifest.files).toEqual([
			{ path: "src/app.ts", status: "included", archivePath: "files/src/app.ts" },
			{ path: "src/gone.ts", status: "missing" },
			{ path: ".env", status: "excluded", reason: "may hold credentials" },
		]);
		const messages = JSON.parse(readFileSync(join(out, manifest.sessions[0].messages), "utf8"));
		expect(messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(messages[0].content).toEqual([{ type: "text", text: "first session" }]);
		expect(messages[1].content[0]).toEqual({ type: "thinking", text: "Plan the change." });
		expect(messages[1].content[2]).toMatchObject({
			type: "tool_call",
			tool: "write",
			arguments: { path: "src/app.ts" },
		});
		expect(messages[2].content[0]).toMatchObject({ type: "tool_result", tool: "write", text: "Wrote src/app.ts" });
		expect(readFileSync(join(out, manifest.sessions[0].transcript), "utf8")).toContain("# Fix the login");
	});

	describe("never takes a file from outside the project", () => {
		let outside: string;
		beforeEach(() => {
			outside = join(root, "outside");
			mkdirSync(outside);
			writeFileSync(join(outside, "private.txt"), "PRIVATE-OUTSIDE\n");
		});

		it("refuses .. in a path, even one that comes back into the project", () => {
			for (const path of ["../outside/private.txt", "src/../../outside/private.txt", "src/../src/app.ts", ".."]) {
				expect(fileExclusion(path, cwd), path).toBe("outside the project folder");
				expect(readProjectFile(path, cwd), path).toEqual({ reason: "outside the project folder" });
			}
		});

		it("refuses a folder of the path that is a link, wherever it leads", () => {
			symlinkSync(outside, join(cwd, "linked"));
			mkdirSync(join(cwd, "deep"));
			symlinkSync(outside, join(cwd, "deep", "inner"));
			symlinkSync(join(cwd, "src"), join(cwd, "alias"));
			for (const path of ["linked/private.txt", "deep/inner/private.txt", "alias/app.ts"]) {
				expect(fileExclusion(path, cwd), path).toBe("a symbolic link in its path");
			}
			const built = buildPortableExport({ cwd, sessions: [], files: ["linked/private.txt"], secrets: new Map() });
			expect(built.files).toEqual([
				{ path: "linked/private.txt", status: "excluded", reason: "a symbolic link in its path" },
			]);
			expect(built.entries.map((entry) => entry.name)).toEqual(["manifest.json", "IMPORT.md"]);
		});

		// Hardening review, point 6: the archive is built in memory, so the files it holds are bounded as a whole.
		it("leaves out the files past the archive's total size limit", () => {
			writeFileSync(join(cwd, "a.txt"), "x".repeat(6));
			writeFileSync(join(cwd, "b.txt"), "y".repeat(6));
			writeFileSync(join(cwd, "c.txt"), "z".repeat(4));
			const built = buildPortableExport({
				cwd,
				sessions: [],
				files: ["a.txt", "b.txt", "c.txt"],
				secrets: new Map(),
				maxTotalBytes: 10,
			});
			expect(built.files).toEqual([
				{ path: "a.txt", status: "included", archivePath: "files/a.txt" },
				{ path: "b.txt", status: "excluded", reason: "the archive's size limit is reached" },
				{ path: "c.txt", status: "included", archivePath: "files/c.txt" },
			]);
			expect(MAX_TOTAL_FILE_BYTES).toBeGreaterThanOrEqual(MAX_FILE_BYTES);
		});

		it("refuses a file swapped for a link between the check and the read", () => {
			const swap = () => {
				rmSync(join(cwd, "src", "app.ts"));
				symlinkSync(join(outside, "private.txt"), join(cwd, "src", "app.ts"));
			};
			expect(readProjectFile("src/app.ts", cwd, swap)).toEqual({ reason: "a symbolic link" });
		});

		it("refuses a folder swapped for a link between the check and the read", () => {
			writeFileSync(join(outside, "app.ts"), "PRIVATE-OUTSIDE\n");
			const swap = () => {
				renameSync(join(cwd, "src"), join(cwd, "src-old"));
				symlinkSync(outside, join(cwd, "src"));
			};
			expect(readProjectFile("src/app.ts", cwd, swap)).toEqual({ reason: "outside the project folder" });
		});

		it("refuses a file swapped for another file of the project after the check", () => {
			writeFileSync(join(cwd, "src", "other.ts"), "other\n");
			const swap = () => {
				renameSync(join(cwd, "src"), join(cwd, "src-old"));
				mkdirSync(join(cwd, "src2"));
				writeFileSync(join(cwd, "src2", "app.ts"), "x\n");
				symlinkSync(join(cwd, "src2"), join(cwd, "src"));
			};
			expect(readProjectFile("src/app.ts", cwd, swap)).toEqual({ reason: "changed while being read" });
		});

		it("writes the archive only where nothing exists, never through a link", () => {
			const existing = join(root, "existing.zip");
			writeFileSync(existing, "keep me");
			expect(() => writeArchiveFile(existing, [])).toThrow(/EEXIST/);
			expect(readFileSync(existing, "utf8")).toBe("keep me");
			const victim = join(outside, "victim.txt");
			writeFileSync(victim, "untouched");
			symlinkSync(victim, join(root, "link.zip"));
			expect(() => writeArchiveFile(join(root, "link.zip"), [])).toThrow(/EEXIST/);
			expect(readFileSync(victim, "utf8")).toBe("untouched");
			symlinkSync(join(outside, "created-by-link.zip"), join(root, "dangling.zip"));
			expect(() => writeArchiveFile(join(root, "dangling.zip"), [])).toThrow(/EEXIST/);
			expect(() => readFileSync(join(outside, "created-by-link.zip"))).toThrow(/ENOENT/);
		});
	});

	// Consolidation: sessions are loaded whole and turned into JSON and Markdown in memory, about five
	// times their size on disk (measured). Past the limit nothing is exported, rather than a partial archive.
	describe("the archive's destination", () => {
		it("resolves a typed path from the project; a folder takes the generated name; .zip is added", () => {
			mkdirSync(join(root, "out"));
			expect(archiveDestination("", cwd, "gen.zip")).toEqual({ path: join(cwd, "gen.zip") });
			expect(archiveDestination(" mine ", cwd, "gen.zip")).toEqual({ path: join(cwd, "mine.zip") });
			expect(archiveDestination("../out", cwd, "gen.zip")).toEqual({ path: join(root, "out", "gen.zip") });
			expect(archiveDestination(join(root, "out", "a.ZIP"), cwd, "gen.zip")).toEqual({
				path: join(root, "out", "a.ZIP"),
			});
			expect(archiveDestination("nowhere/a.zip", cwd, "gen.zip")).toEqual({
				problem: `Folder not found: ${join(cwd, "nowhere")}`,
			});
			writeFileSync(join(cwd, "taken.zip"), "kept");
			expect(archiveDestination("taken", cwd, "gen.zip")).toEqual({
				problem: `${join(cwd, "taken.zip")} already exists: choose another name.`,
			});
		});

		it("is changed from the terminal's summary, then written there", async () => {
			const manager = session("s1", "first");
			mkdirSync(join(root, "out"));
			let command: RegisteredCommand | undefined;
			portableExport({
				registerCommand: (_name: string, options: RegisteredCommand) => {
					command = options;
				},
			} as unknown as ExtensionAPI);
			const summaries: string[] = [];
			const answers = ["nowhere/a", "../out/mine"];
			const inputs: [string, string | undefined][] = [];
			const notes: [string, string | undefined][] = [];
			const ctx = {
				hasUI: true,
				mode: "tui",
				cwd,
				sessionManager: manager,
				ui: {
					select: async (title: string) => {
						if (!title.startsWith("Portable export")) return "Continue";
						summaries.push(title);
						return summaries.length < 3 ? "Change the destination" : "Create the archive";
					},
					input: async (title: string, placeholder?: string) => {
						inputs.push([title, placeholder]);
						return answers.shift();
					},
					notify: (message: string, type?: string) => notes.push([message, type]),
				},
			} as unknown as ExtensionCommandContext;
			await command!.handler("", ctx);
			expect(inputs[0]![0]).toBe("Archive destination (a file or a folder)");
			expect(inputs[0]![1]).toMatch(new RegExp(`^${cwd}/.*-export-\\d{8}-\\d{4}\\.zip$`));
			const target = join(root, "out", "mine.zip");
			expect(summaries[2]).toContain(`Archive: ${target}`);
			expect(notes).toEqual([
				[`Folder not found: ${join(cwd, "nowhere")}`, "warning"],
				[`Archive written: ${target}`, "info"],
			]);
			expect(execFileSync("unzip", ["-Z1", target], { encoding: "utf8" })).toContain("manifest.json");
		});
	});

	describe("the total size of the chosen sessions", () => {
		it("refuses sessions past the limit, from their size on disk", () => {
			const a = session("s1", "first").getSessionFile()!;
			const b = session("s2", "second").getSessionFile()!;
			const size = readFileSync(a).length + readFileSync(b).length;
			expect(sessionsSizeProblem([a, b], size)).toBeUndefined();
			expect(sessionsSizeProblem([a, b], size - 1)).toContain("nothing exported");
			expect(() =>
				buildPortableExport({
					cwd,
					sessions: [
						{ path: a, id: "s1" },
						{ path: b, id: "s2" },
					],
					files: [],
					maxSessionBytes: size - 1,
				}),
			).toThrow(/nothing exported/);
			expect(MAX_TOTAL_SESSION_BYTES).toBe(200 * 1024 * 1024);
		});

		it("says so in /export-zip before loading them, and writes nothing", async () => {
			const manager = session("s1", "first");
			let command: RegisteredCommand | undefined;
			portableExport(
				{
					registerCommand: (_name: string, options: RegisteredCommand) => {
						command = options;
					},
				} as unknown as ExtensionAPI,
				10,
			);
			const selects: string[] = [];
			const notes: [string, string | undefined][] = [];
			const ctx = {
				hasUI: true,
				mode: "tui",
				cwd,
				sessionManager: manager,
				ui: {
					select: async (title: string) => {
						selects.push(title);
						return "Continue";
					},
					notify: (message: string, type?: string) => notes.push([message, type]),
				},
			} as unknown as ExtensionCommandContext;
			await command!.handler("", ctx);
			expect(selects).toEqual(["Sessions to export"]);
			expect(notes).toHaveLength(1);
			expect(notes[0]![0]).toMatch(/more than the 1 MB an archive can hold: nothing exported/);
			expect(notes[0]![1]).toBe("warning");
			expect(execFileSync("ls", [cwd], { encoding: "utf8" })).not.toContain(".zip");
		});
	});

	// a classic ZIP holds at most 65 535 entries.
	describe("the number of entries of the archive", () => {
		it("refuses more sessions than the entries allow, before loading any", () => {
			expect(sessionCountProblem(32_766)).toBeUndefined();
			expect(sessionCountProblem(32_767)).toContain("more than the 32766 an archive can hold: nothing exported");
			// Paths that do not exist: loading one would fail with another error.
			const sessions = ["a", "b", "c"].map((id) => ({ path: join(root, "missing", id), id }));
			expect(() => buildPortableExport({ cwd, sessions, files: [], secrets: new Map(), maxEntries: 7 })).toThrow(
				/3 sessions chosen, more than the 2 an archive can hold/,
			);
		});

		it("leaves out the files past the entry limit, the manifest and the guide counted", () => {
			for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(cwd, name), name);
			const path = session("s1", "first").getSessionFile()!;
			const built = buildPortableExport({
				cwd,
				sessions: [{ path, id: "s1" }],
				files: ["a.txt", "b.txt", "c.txt"],
				secrets: new Map(),
				maxEntries: 6,
			});
			expect(built.files.map((file) => file.status)).toEqual(["included", "included", "excluded"]);
			expect(built.files[2]?.reason).toBe("the archive's entry limit is reached");
			expect(built.entries).toHaveLength(6);
		});
	});
});
