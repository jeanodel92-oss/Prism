// fork: invariants of the built-in tools and of the permission gate against trapped paths.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { fdUnreadablePathErrors, unreadablePathErrors } from "../src/fork/grep-unreadable.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadTool,
	createWriteTool,
} from "../src/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

type TextResult = { content: Array<{ type: string; text?: string }> };
function output(result: TextResult): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

describe("built-in tool path invariants in a temporary workspace", () => {
	let root: string;
	let outside: string;
	let tools: {
		read: ReturnType<typeof createReadTool>;
		write: ReturnType<typeof createWriteTool>;
		edit: ReturnType<typeof createEditTool>;
		ls: ReturnType<typeof createLsTool>;
		find: ReturnType<typeof createFindTool>;
		grep: ReturnType<typeof createGrepTool>;
		bash: ReturnType<typeof createBashTool>;
	};
	let powershell: ReturnType<typeof createPowerShellTool>;
	let previousOffline: string | undefined;
	beforeEach(async () => {
		previousOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1";
		root = await mkdtemp(join(tmpdir(), "prism-tool-invariants-"));
		outside = await mkdtemp(join(tmpdir(), "prism-tool-outside-"));
		await writeFile(join(root, "inside.txt"), "inside marker\n");
		await writeFile(join(outside, "outside.txt"), "outside canary\n");
		await mkdir(join(root, "folder"));
		await writeFile(join(root, "folder", "nested.txt"), "nested marker\n");
		await symlink(join(outside, "outside.txt"), join(root, "file-link"));
		await symlink(outside, join(root, "dir-link"));
		await symlink(join(root, "missing"), join(root, "dangling-link"));
		await symlink(join(root, "loop-b"), join(root, "loop-a"));
		await symlink(join(root, "loop-a"), join(root, "loop-b"));
		await writeFile(join(root, "café.txt"), "NFC\n");
		await writeFile(join(root, "café.txt"), "NFD\n");
		await writeFile(join(root, "rtl-‮exe.txt"), "rtl\n");
		await writeFile(join(root, "zero-​-width.txt"), "zero\n");
		await writeFile(join(root, `${"long-name-".repeat(23)}end.txt`), "long name\n");
		tools = {
			read: createReadTool(root),
			write: createWriteTool(root),
			edit: createEditTool(root),
			ls: createLsTool(root),
			find: createFindTool(root),
			grep: createGrepTool(root),
			bash: createBashTool(root),
		};
		powershell = createPowerShellTool(root, {
			operations: {
				exec: async (_command, cwd, { onData }) => {
					onData(Buffer.from(cwd));
					return { exitCode: 0 };
				},
			},
		});
	});
	afterEach(async () => {
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	});

	it("read resolves ordinary relative paths and reports the requested file content", async () => {
		assert.match(output((await tools.read.execute("read", { path: "inside.txt" })) as TextResult), /inside marker/);
		const parentPath = relative(root, join(outside, "outside.txt"));
		assert.match(output((await tools.read.execute("read", { path: parentPath })) as TextResult), /outside canary/);
	});
	// The tools are not confined to the workspace (`..` and absolute paths work, as above): they follow
	// symlinks like any path. Confinement is the permission gate's job, tested in the next describe.
	it("file tools follow symlinks to their target, like any other path", async () => {
		assert.match(output((await tools.read.execute("read", { path: "file-link" })) as TextResult), /outside canary/);
		assert.match(output((await tools.ls.execute("ls", { path: "dir-link" })) as TextResult), /outside\.txt/);
		await tools.edit.execute("edit", { path: "file-link", edits: [{ oldText: "outside", newText: "edited" }] });
		assert.equal(await readFile(join(outside, "outside.txt"), "utf8"), "edited canary\n");
	});
	it("read returns promptly for dangling links and symlink loops", async () => {
		const timeout = setTimeout(() => {
			throw new Error("read path resolution timeout");
		}, 1500);
		try {
			const results = await Promise.allSettled([
				tools.read.execute("read", { path: "dangling-link" }),
				tools.read.execute("read", { path: "loop-a" }),
			]);
			assert.ok(results.every((result) => result.status === "rejected" && result.reason instanceof Error));
		} finally {
			clearTimeout(timeout);
		}
	});
	it("write and edit keep writes inside the named workspace file", async () => {
		await tools.write.execute("write", { path: "inside.txt", content: "replaced\n" });
		assert.equal(await readFile(join(root, "inside.txt"), "utf8"), "replaced\n");
		await tools.edit.execute("edit", { path: "inside.txt", edits: [{ oldText: "replaced", newText: "edited" }] });
		assert.equal(await readFile(join(root, "inside.txt"), "utf8"), "edited\n");
		assert.equal(await readFile(join(outside, "outside.txt"), "utf8"), "outside canary\n");
	});
	it("ls, find, and grep handle Unicode names and traversal syntax without crashing", async () => {
		const listing = output((await tools.ls.execute("ls", { path: "." })) as TextResult);
		assert.match(listing, /café\.txt/);
		assert.ok(output((await tools.ls.execute("ls", { path: ".." })) as TextResult).length > 0);
		// find and grep need fd and rg, which the machine may lack (./test.sh downloads nothing).
		try {
			assert.match(
				output((await tools.find.execute("find", { pattern: "*.txt", path: "." })) as TextResult),
				/nested\.txt/,
			);
		} catch (error) {
			assert.match(String(error), /fd is not available/);
		}
		try {
			assert.match(
				output((await tools.grep.execute("grep", { pattern: "marker", path: "." })) as TextResult),
				/inside\.txt/,
			);
		} catch (error) {
			assert.match(String(error), /ripgrep \(rg\) is not available/);
		}
	});
	it("bash runs with the supplied workspace as cwd and reports command failures", async () => {
		const result = (await tools.bash.execute("bash", { command: "pwd", timeout: 2 })) as TextResult;
		assert.match(output(result), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	});
	it("bash enforces its requested execution timeout", async () => {
		const started = performance.now();
		await assert.rejects(tools.bash.execute("bash", { command: "sleep 3", timeout: 0.2 }), /timed out/);
		assert.ok(performance.now() - started < 1500);
	});
	it("powershell passes the workspace cwd to its executor", async () => {
		const result = (await powershell.execute("powershell", { command: "pwd" })) as TextResult;
		assert.match(output(result), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	});
	it("write honors explicit absolute and parent paths without changing adjacent canaries", async () => {
		await tools.write.execute("write", { path: join(outside, "absolute.txt"), content: "requested" });
		assert.equal(await readFile(join(outside, "absolute.txt"), "utf8"), "requested");
		assert.equal(await readFile(join(outside, "outside.txt"), "utf8"), "outside canary\n");
	});
	it("read handles binary files and listing handles long names", async () => {
		await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2, 255]));
		// hotfix 1.0.0-fork.8: a binary file is refused rather than returned as replacement characters.
		await assert.rejects(tools.read.execute("read", { path: "binary.dat" }), /binary file/);
		assert.match(output((await tools.ls.execute("ls", { path: "." })) as TextResult), /long-name-/);
	});
	// "Successfully wrote to file-link" used to hide that the bytes went outside the workspace.
	it("write through a symlink reports the real path it wrote to", async () => {
		const result = (await tools.write.execute("write", { path: "file-link", content: "x" })) as TextResult;
		assert.equal(output(result), `Successfully wrote to file-link (symlink to ${join(outside, "outside.txt")})`);
		const plain = (await tools.write.execute("write", { path: "inside.txt", content: "x" })) as TextResult;
		assert.equal(output(plain), "Successfully wrote to inside.txt");
		// A workspace reached through a symlink is not a link inside the path.
		await symlink(root, `${root}-alias`);
		try {
			const viaAlias = (await createWriteTool(`${root}-alias`).execute("write", {
				path: "inside.txt",
				content: "y",
			})) as TextResult;
			assert.equal(output(viaAlias), "Successfully wrote to inside.txt");
		} finally {
			await rm(`${root}-alias`);
		}
	});
	// a FIFO blocked read, edit and write on open; /dev/zero was buffered until memory ran out.
	// /dev/null stands for character devices here: if the guard regresses, reading it stays harmless.
	it("read, edit and write refuse FIFOs, devices and sockets promptly", async () => {
		execFileSync("mkfifo", [join(root, "pipe")]);
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(join(root, "socket"), resolve));
		const attempt = (run: () => Promise<unknown>) =>
			Promise.race([
				run().then(
					() => "resolved",
					(error: unknown) => String(error),
				),
				new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 1500)),
			]);
		try {
			for (const [path, kind] of [
				["pipe", "a named pipe \\(FIFO\\)"],
				["/dev/null", "a character device"],
				["socket", "a socket"],
			] as const) {
				const expected = new RegExp(`is ${kind}, not a regular file`);
				assert.match(await attempt(() => tools.read.execute("read", { path })), expected, `read ${path}`);
				assert.match(
					await attempt(() => tools.edit.execute("edit", { path, edits: [{ oldText: "a", newText: "b" }] })),
					expected,
					`edit ${path}`,
				);
				if (path !== "/dev/null") {
					assert.match(
						await attempt(() => tools.write.execute("write", { path, content: "x" })),
						expected,
						`write ${path}`,
					);
				}
			}
		} finally {
			// Opening the FIFO read-write never blocks and releases any open still waiting on it.
			await (await open(join(root, "pipe"), constants.O_RDWR | constants.O_NONBLOCK)).close();
			server.close();
		}
	});
	// rg exits with code 2 when one path is unreadable, and grep used to drop every match.
	it("unreadable files and folders give clear errors, and grep still searches the rest", async (context) => {
		if (process.getuid?.() === 0) context.skip(); // root ignores file permissions
		await mkdir(join(root, "locked"));
		await writeFile(join(root, "locked", "inner.txt"), "marker inner\n");
		await writeFile(join(root, "locked-file.txt"), "marker locked\n");
		await chmod(join(root, "locked"), 0o000);
		await chmod(join(root, "locked-file.txt"), 0o000);
		try {
			await assert.rejects(tools.read.execute("read", { path: "locked-file.txt" }), /EACCES/);
			await assert.rejects(tools.read.execute("read", { path: "locked/inner.txt" }), /EACCES/);
			await assert.rejects(
				tools.edit.execute("edit", { path: "locked-file.txt", edits: [{ oldText: "marker", newText: "x" }] }),
				/EACCES/,
			);
			await assert.rejects(tools.write.execute("write", { path: "locked-file.txt", content: "x" }), /EACCES/);
			await assert.rejects(tools.write.execute("write", { path: "locked/new.txt", content: "x" }), /EACCES/);
			await assert.rejects(tools.ls.execute("ls", { path: "locked" }), /EACCES/);
			assert.match(output((await tools.ls.execute("ls", { path: "." })) as TextResult), /locked-file\.txt/);
			// find names the folders fd could not open (fd may be missing: ./test.sh downloads nothing).
			try {
				const files = output((await tools.find.execute("find", { pattern: "*.txt", path: "." })) as TextResult);
				assert.match(files, /inside\.txt/);
				assert.doesNotMatch(files, /inner\.txt/);
				assert.match(files, /\n\n\[1 path\(s\) could not be searched: .*locked: Permission denied/);
				const inside = output(
					(await tools.find.execute("find", { pattern: "*.txt", path: "locked" })) as TextResult,
				);
				assert.match(inside, /^No files found matching pattern\n\n\[1 path\(s\) could not be searched/);
			} catch (error) {
				assert.match(String(error), /fd is not available/);
			}
			try {
				const found = output((await tools.grep.execute("grep", { pattern: "marker", path: "." })) as TextResult);
				assert.match(found, /inside\.txt:1: inside marker/);
				assert.match(found, /2 path\(s\) could not be searched: .*Permission denied/);
				const none = output(
					(await tools.grep.execute("grep", { pattern: "absent-text", path: "." })) as TextResult,
				);
				assert.match(none, /^No matches found\n\n\[2 path\(s\) could not be searched/);
				// The pattern follows `--`: an rg option given as a pattern is searched for, never run.
				const option = output(
					(await tools.grep.execute("grep", { pattern: "--pre=touch", path: "." })) as TextResult,
				);
				assert.match(option, /^No matches found/);
			} catch (error) {
				assert.match(String(error), /ripgrep \(rg\) is not available/);
			}
			// fd's other messages are not per-path errors.
			assert.deepEqual(
				fdUnreadablePathErrors(
					"[fd error]: a: Permission denied (os error 13)\n[fd error]: Search path 'b' is not a directory.\n",
				),
				["a: Permission denied (os error 13)"],
			);
			// Any other rg error keeps failing the call, even next to per-path errors.
			assert.equal(
				unreadablePathErrors("rg: /a: Permission denied (os error 13)\nrg: regex parse error:\n    (\n    ^"),
				undefined,
			);
			await assert.rejects(tools.grep.execute("grep", { pattern: "(", path: "." }), /regex parse error/);
		} finally {
			await chmod(join(root, "locked"), 0o755);
			await chmod(join(root, "locked-file.txt"), 0o644);
		}
	});
});

describe("permission gate against symlinks", () => {
	let agentDir: string;
	const savedAgentDir = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "prism-gate-symlink-"));
		process.env[ENV_AGENT_DIR] = agentDir;
	});
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	/** Runs one tool call in broad mode (or `mode`), blocking every confirmation; returns the dialogs. */
	async function callInBroadMode(
		tool: string,
		input: Parameters<typeof fauxToolCall>[1],
		setup: (cwd: string) => Promise<void>,
		mode = "broad",
	): Promise<{ titles: string[]; dialogs: string[]; results: string[] }> {
		const dialogs: string[] = [];
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
		});
		harnesses.push(harness);
		await setup(harness.tempDir);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title) => {
					dialogs.push(title);
					return "Block this action once";
				},
			}),
		});
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt(`/perm mode ${mode}`);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall(tool, input), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const results = harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => output(message as TextResult));
		return { titles: dialogs.map((dialog) => dialog.split("\n")[0] ?? ""), dialogs, results };
	}

	// fork: credential writes now refuse without asking, including links and missing targets.
	it("refuses writing the credential file named directly", async () => {
		await writeFile(join(agentDir, "auth.json"), "{}\n");
		const { titles, results } = await callInBroadMode(
			"write",
			{ path: join(agentDir, "auth.json"), content: "x" },
			async () => {},
		);
		assert.deepEqual(titles, []);
		assert.match(results[0] ?? "", /Only the user/);
		assert.equal(await readFile(join(agentDir, "auth.json"), "utf8"), "{}\n");
	});
	// the gate used to classify the path as written, not its symlink target, so a link
	// inside the project turned a dangerous write into an ordinary one.
	it("refuses writing the credential file through a symlink in the project", async () => {
		await writeFile(join(agentDir, "auth.json"), "{}\n");
		const { titles, results } = await callInBroadMode("write", { path: "notes.json", content: "x" }, (cwd) =>
			symlink(join(agentDir, "auth.json"), join(cwd, "notes.json")),
		);
		assert.deepEqual(titles, []);
		assert.match(results[0] ?? "", /Only the user/);
		assert.equal(await readFile(join(agentDir, "auth.json"), "utf8"), "{}\n");
	});
	it("asks before reading the credential file through a symlink", async () => {
		await writeFile(join(agentDir, "auth.json"), "{}\n");
		const { titles, dialogs } = await callInBroadMode("read", { path: "creds" }, (cwd) =>
			symlink(join(agentDir, "auth.json"), join(cwd, "creds")),
		);
		assert.deepEqual(titles, ["Potentially dangerous action: read"]);
		assert.match(dialogs[0] ?? "", /Prism config or credential file/);
	});
	it("refuses creating the credential file through a dangling symlink", async () => {
		const { titles, results } = await callInBroadMode("write", { path: "new.json", content: "x" }, (cwd) =>
			symlink(join(agentDir, "auth.json"), join(cwd, "new.json")),
		);
		assert.deepEqual(titles, []);
		assert.match(results[0] ?? "", /Only the user/);
		await assert.rejects(readFile(join(agentDir, "auth.json"), "utf8"));
	});
	it("asks before writing outside the project through a symlinked directory", async () => {
		const { titles, dialogs } = await callInBroadMode("write", { path: "out/x.txt", content: "x" }, (cwd) =>
			symlink(agentDir, join(cwd, "out")),
		);
		assert.deepEqual(titles, ["Potentially dangerous action: write"]);
		assert.match(dialogs[0] ?? "", /outside project through a symlink/);
		await assert.rejects(readFile(join(agentDir, "x.txt"), "utf8"));
	});
	it("does not ask for a symlink that stays inside the project", async () => {
		let cwd = "";
		const { titles } = await callInBroadMode("write", { path: "alias.txt", content: "new" }, async (dir) => {
			cwd = dir;
			await writeFile(join(dir, "real.txt"), "old");
			await symlink(join(dir, "real.txt"), join(dir, "alias.txt"));
		});
		assert.deepEqual(titles, []);
		assert.equal(await readFile(join(cwd, "real.txt"), "utf8"), "new");
	});
	it("classifies a symlink loop without hanging or crashing", async () => {
		const { titles, results } = await callInBroadMode("write", { path: "loop-a", content: "x" }, async (cwd) => {
			await symlink(join(cwd, "loop-b"), join(cwd, "loop-a"));
			await symlink(join(cwd, "loop-a"), join(cwd, "loop-b"));
		});
		assert.deepEqual(titles, []);
		// The write tool itself reports the loop; the gate neither crashed nor blocked the call.
		assert.match(results[0] ?? "", /ELOOP/);
	});
	it("asks before reading a protected file named directly", async () => {
		const { titles } = await callInBroadMode("read", { path: ".env" }, (cwd) =>
			writeFile(join(cwd, ".env"), "SECRET=1\n"),
		);
		assert.deepEqual(titles, ["Potentially dangerous action: read"]);
	});
	// Same defect for protected paths: a link named notes.txt hid the .env it points to.
	it("asks before reading a protected file through a symlink", async () => {
		const { titles } = await callInBroadMode("read", { path: "notes.txt" }, async (cwd) => {
			await writeFile(join(cwd, ".env"), "SECRET=1\n");
			await symlink(join(cwd, ".env"), join(cwd, "notes.txt"));
		});
		assert.deepEqual(titles, ["Potentially dangerous action: read"]);
	});
	it("matches allow rules against the real target, not the link", async () => {
		await writeFile(join(agentDir, "permissions.json"), JSON.stringify({ allow: ["write(docs/**)"] }));
		const setup = async (cwd: string) => {
			await mkdir(join(cwd, "docs"));
			await mkdir(join(cwd, "src"));
			await writeFile(join(cwd, "src", "main.ts"), "old");
			await symlink(join(cwd, "src", "main.ts"), join(cwd, "docs", "main.ts"));
		};
		const plain = await callInBroadMode("write", { path: "docs/note.md", content: "x" }, setup, "ask");
		assert.deepEqual(plain.titles, []);
		const linked = await callInBroadMode("write", { path: "docs/main.ts", content: "x" }, setup, "ask");
		assert.deepEqual(linked.titles, ["Allow this action? write"]);
	});
});
