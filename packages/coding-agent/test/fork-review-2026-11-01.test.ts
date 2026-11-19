// fork: defects found by the code review of 2026-11-01, each checked on the
// guard's decision and, where the tool can run here, on its real effect (synthetic canaries in a throwaway HOME).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import permissionsExtension, { decidePermission, type Mode, questionTarget } from "../src/fork/permissions.ts";
import { realPath } from "../src/fork/real-path.ts";
import { isExcludedCommand } from "../src/fork/sandbox/layout.ts";
import { findBwrap } from "../src/fork/sandbox/runtime.ts";
import { passRuleMatches } from "../src/fork/secrets/env.ts";
import { unseenCodeReason } from "../src/fork/shell-unseen-code.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

const CANARY = "PRISM-CANARY-7f3a9c";
const FAKE_LSP = join(import.meta.dirname, "fixtures", "fake-lsp-server.mjs");

describe("fork: code review of 2026-11-01", () => {
	let root: string;
	let home: string;
	let agentDir: string;
	let project: string;
	const saved = { home: process.env.HOME, agentDir: process.env[ENV_AGENT_DIR] };
	const harnesses: Harness[] = [];

	beforeEach(() => {
		// Not under /tmp: with the sandbox on, the file tools move a /tmp path into the session's private /tmp.
		root = realPath(mkdtempSync(join(existsSync("/var/tmp") ? "/var/tmp" : tmpdir(), "prism-review-1101-")));
		home = join(root, "home");
		agentDir = join(home, ".pi", "agent");
		project = join(home, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(home, ".ssh"));
		mkdirSync(join(home, ".aws"));
		mkdirSync(join(home, ".kube"));
		mkdirSync(join(home, ".config", "gh"), { recursive: true });
		mkdirSync(project, { recursive: true });
		writeFileSync(join(agentDir, "auth.json"), "{}");
		writeFileSync(join(home, ".ssh", "id_ed25519"), `${CANARY}-ssh`);
		writeFileSync(join(home, ".aws", "credentials"), `[default]\naws_secret_access_key=${CANARY}-aws\n`);
		writeFileSync(join(home, ".kube", "config"), `token: ${CANARY}-kube\n`);
		writeFileSync(join(home, ".config", "gh", "hosts.yml"), `oauth_token: ${CANARY}-gh\n`);
		writeFileSync(join(project, "notes.txt"), "hello\n");
		process.env.HOME = home;
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		process.env.HOME = saved.home;
		if (saved.agentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved.agentDir;
		rmSync(root, { recursive: true, force: true });
	});

	const decide = (tool: string, input: Record<string, unknown>, mode: Mode, cwd = project) =>
		decidePermission(tool, input, cwd, { mode });
	const readEverything = () =>
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { read: { limit: "all" } } }));

	/** A session with the gate in `mode`, run in `cwd`; every question is answered `answer`. */
	async function session(
		mode: Mode,
		answer: string | ((options: string[]) => string | undefined),
		config = true,
		settings: { shellCommandPrefix?: string } = {},
	) {
		if (config) writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode }));
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
			initialActiveToolNames: ["read", "grep", "find", "ls", "bash", "write", "edit"],
			settings,
		});
		harnesses.push(harness);
		const titles: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title, options) => {
					titles.push(title);
					return typeof answer === "string" ? answer : answer(options);
				},
			}),
		});
		const call = async (tool: string, input: Parameters<typeof fauxToolCall>[1]) => {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall(tool, input), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			return JSON.stringify(getToolResult(harness, tool));
		};
		return { harness, titles, call };
	}

	describe("C1: a search from the root folder reaches the credentials", () => {
		it.each<Mode>(["safe", "ask", "broad"])("grep over / asks as dangerous in %s mode", (mode) => {
			expect(decide("grep", { pattern: ".", path: "/", glob: "**/.ssh/id_*" }, mode)).toMatchObject({
				effect: "prompt",
				tier: "danger",
			});
		});

		it("a recursive search of / in bash asks as dangerous too", () => {
			expect(decide("bash", { command: "grep -r . /" }, "broad")).toMatchObject({ tier: "danger" });
			expect(decide("bash", { command: "rg secret /" }, "broad")).toMatchObject({ tier: "danger" });
		});

		it("a search of a folder that holds the home folder does not return the keys (real grep)", async () => {
			const { titles, call } = await session("ask", "Block this action once");
			const result = await call("grep", { pattern: CANARY, path: root });
			expect(titles[0]).toMatch(/^Potentially dangerous action: grep/);
			expect(result).not.toContain(`${CANARY}-ssh`);
			expect(result).not.toContain(`${CANARY}-aws`);
		});

		it("an ordinary search outside the credentials keeps working without a question", () => {
			expect(decide("grep", { pattern: "x", path: "/etc" }, "safe")).toMatchObject({ effect: "allow" });
			expect(decide("grep", { pattern: "x", path: "." }, "safe")).toMatchObject({ effect: "allow" });
		});
	});

	describe("M2: the native tools protect the folders the sandbox hides", () => {
		it.each([".aws/credentials", ".kube/config", ".config/gh/hosts.yml", ".ssh/id_ed25519"])(
			"read ~/%s asks as dangerous with reading not limited",
			(file) => {
				readEverything();
				for (const mode of ["safe", "ask"] as const) {
					expect(decide("read", { path: join(home, file) }, mode)).toMatchObject({
						effect: "prompt",
						tier: "danger",
					});
				}
			},
		);

		it("the question names credentials and the canary is not read when refused (real read)", async () => {
			readEverything();
			const { titles, call } = await session("ask", "Block this action once");
			const result = await call("read", { path: "~/.aws/credentials" });
			expect(titles[0]).toMatch(/^Potentially dangerous action: read/);
			expect(titles[0]).toMatch(/credential/);
			expect(titles[0]).not.toMatch(/in this session/);
			expect(result).not.toContain(`${CANARY}-aws`);
		});

		it("Prism's own folder keeps its policy: skills readable, auth.json dangerous", () => {
			mkdirSync(join(agentDir, "skills", "x"), { recursive: true });
			writeFileSync(join(agentDir, "skills", "x", "SKILL.md"), "skill");
			expect(decide("read", { path: join(agentDir, "skills", "x", "SKILL.md") }, "safe")).toMatchObject({
				effect: "allow",
			});
			expect(decide("read", { path: join(agentDir, "auth.json") }, "safe")).toMatchObject({ tier: "danger" });
		});
	});

	describe("H3: a permissions file that does not parse fails closed", () => {
		const write = (text: string) => writeFileSync(join(agentDir, "permissions.json"), text);
		const curl = (mode: Mode = "broad") => decide("bash", { command: "curl https://example.com" }, mode);

		it.each([
			["a trailing comma", '{ "deny": ["bash(curl*)"], }'],
			["an entry that is not text", '{ "deny": ["bash(curl*)", 3] }'],
			["a tool effect in the wrong case", '{ "deny": ["bash(curl*)"], "tools": { "bash": "Deny" } }'],
			["a rule that does not parse", '{ "deny": ["bash(curl*"] }'],
			["an unknown mode", '{ "mode": "Safe", "deny": ["bash(curl*)"] }'],
		])("%s refuses every call, with the reason", (_why, text) => {
			write(text);
			for (const call of [curl(), decide("read", { path: join(project, "notes.txt") }, "broad")]) {
				expect(call).toMatchObject({ effect: "block" });
				expect(call.reason).toMatch(/is not a valid permissions file/);
				expect(call.reason).toMatch(/Do not retry/);
			}
		});

		it("keeps the last valid version read when the file breaks later", () => {
			write('{ "deny": ["bash(curl*)"] }');
			expect(curl()).toMatchObject({ effect: "block", reason: 'Denied by rule "bash(curl*)"' });
			write('{ "deny": ["bash(curl*)"], }');
			expect(curl()).toMatchObject({ effect: "block", reason: 'Denied by rule "bash(curl*)"' });
			expect(decide("read", { path: join(project, "notes.txt") }, "broad")).toMatchObject({ effect: "allow" });
		});

		it("an answer that saves a rule never rewrites a broken file (real session)", async () => {
			write('{ "mode": "ask", "deny": ["bash(curl*)"] }');
			const always = (options: string[]) => options.find((option) => option.startsWith("Always block"));
			const { titles, call } = await session("ask", always, false);
			// The session read the valid file; it breaks, and the user saves a deny rule from a question.
			const broken = '{ "mode": "ask", "deny": ["bash(curl*)"], }';
			write(broken);
			expect(await call("bash", { command: "curl https://example.com" })).toContain(
				'Denied by rule \\"bash(curl*)\\"',
			);
			const result = await call("bash", { command: 'rm -rf "$UNSET"build' });
			expect(titles).toHaveLength(1);
			expect(result).toContain("Denied");
			expect(readFileSync(join(agentDir, "permissions.json"), "utf8")).toBe(broken);
		});

		it("a project permissions file that does not parse refuses every call", () => {
			writeFileSync(join(agentDir, "project-permissions.json"), '{ "projects": { "x": { "deny": [1] } } }');
			expect(decide("read", { path: join(project, "notes.txt") }, "broad")).toMatchObject({ effect: "block" });
			writeFileSync(join(agentDir, "project-permissions.json"), "{ nope");
			expect(decide("read", { path: join(project, "notes.txt") }, "broad").reason).toMatch(
				/not a valid project permissions file/,
			);
		});
	});

	describe.skipIf(!findBwrap())("C2: a language server runs project code", () => {
		/** A session with the gate and pi-lsp, whose fake server leaves witnesses in the project and in the home. */
		async function lspSession(mode: Mode, sandboxed: boolean, answer: string) {
			const lsp = builtInExtensions.find(
				(extension) => typeof extension !== "function" && extension.name === "pi-lsp",
			);
			if (!lsp || typeof lsp === "function") throw new Error("no built-in pi-lsp");
			if (!sandboxed)
				writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { modes: { [mode]: false } } }));
			writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode }));
			const harness = await createHarness({
				extensionFactories: [
					{ name: "permissions", factory: permissionsExtension },
					{ name: "pi-lsp", factory: lsp.factory },
				],
			});
			harnesses.push(harness);
			// The server's script in the project, which the sandbox shows (the repository is not in the project).
			const server = join(harness.tempDir, "server.mjs");
			writeFileSync(server, readFileSync(FAKE_LSP));
			writeFileSync(join(harness.tempDir, "a.fake"), "x\n");
			const witnesses = { project: join(harness.tempDir, "built.txt"), home: join(home, "escaped.txt") };
			writeFileSync(
				join(agentDir, "pi-lsp.json"),
				JSON.stringify({
					timeout: 20_000,
					servers: {
						fake: {
							command: [process.execPath, server],
							extensions: [".fake"],
							env: { FAKE_LSP_WITNESSES: `${witnesses.project}:${witnesses.home}`, FAKE_LSP_PAD: "0" },
						},
					},
				}),
			);
			const titles: string[] = [];
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({
					select: async (title, options) => {
						titles.push(title);
						return options.find((option) => option.startsWith(answer));
					},
				}),
			});
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("lsp_diagnostics", { paths: ["a.fake"] }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			return { titles, witnesses, result: JSON.stringify(getToolResult(harness, "lsp_diagnostics")) };
		}

		it("with the sandbox, the server runs in it: it builds in the project and cannot write the home", async () => {
			const { titles, witnesses, result } = await lspSession("broad", true, "Allow");
			expect(titles).toEqual([]);
			expect(existsSync(witnesses.project), result).toBe(true);
			expect(existsSync(witnesses.home)).toBe(false);
		});

		it("without the sandbox, it is a dangerous question, and a refusal starts nothing", async () => {
			const { titles, witnesses } = await lspSession("broad", false, "Block this action once");
			expect(titles[0]).toMatch(/^Potentially dangerous action: lsp_diagnostics/);
			expect(titles[0]).toMatch(/runs outside the sandbox/);
			expect(existsSync(witnesses.project)).toBe(false);
			expect(existsSync(witnesses.home)).toBe(false);
		});

		it("safe mode refuses it, as any program", () => {
			expect(decide("lsp_diagnostics", { paths: ["a.fake"] }, "safe")).toMatchObject({ effect: "block" });
		});
	});

	describe("H2: a rule covers a command that runs another", () => {
		const hidden = [
			"npm run test <(node evil.js)",
			"npm run test >(node evil.js)",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion, not a template.
			"npm run test ${x:=\\$\\(node evil.js\\)} ${x@P}",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion, not a template.
			"npm run test ${!x}",
			"npm run test $((x))",
			"npm run test $[x]",
			"npm run test $'\\x24(id)'",
			"read x <evil.txt; npm run test",
			"[[ x -eq 0 ]]; npm run test",
			"a[x]=1 npm run test",
			"declare -i n=x; npm run test",
			"npm run test `id`",
			"npm run test $(id)",
		];
		const plain = ["npm run test", "npm run build -- --port $PORT", "npm run lint -- --fix", 'npm run test -- "a b"'];

		it.each(hidden)("refuses to trust by its words: %s", (command) => {
			expect(unseenCodeReason(command), command).toBeDefined();
			expect(
				decidePermission("bash", { command }, project, { mode: "ask", allow: ["bash(npm run*)"] }).effect,
				command,
			).not.toBe("allow");
			expect(isExcludedCommand(command, ["npm"]), command).toBe(false);
			expect(passRuleMatches("bash(npm *)", "bash", command), command).toBe(false);
		});

		it.each(plain)("still trusts a plain command: %s", (command) => {
			expect(unseenCodeReason(command)).toBeUndefined();
			expect(decidePermission("bash", { command }, project, { mode: "ask", allow: ["bash(npm run*)"] }).effect).toBe(
				"allow",
			);
		});

		it.skipIf(!findBwrap())("a refused question runs none of the hidden code", async () => {
			writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "ask", allow: ["bash(npm run*)"] }));
			const { harness, titles, call } = await session("ask", "Block this action once", false);
			const one = join(harness.tempDir, "w1");
			const two = join(harness.tempDir, "w2");
			await call("bash", { command: `npm run test <(touch ${one})` });
			await call("bash", { command: `npm run test \${x:=\\$\\(touch ${two}\\)} \${x@P}` });
			expect(titles).toHaveLength(2);
			expect(existsSync(one)).toBe(false);
			expect(existsSync(two)).toBe(false);
			// The same commands, allowed once: the witnesses show what the rule used to let through.
			const allowed = await session("ask", "Allow once", false);
			const three = join(allowed.harness.tempDir, "w3");
			const four = join(allowed.harness.tempDir, "w4");
			await allowed.call("bash", { command: `npm run test <(touch ${three})` });
			await allowed.call("bash", { command: `npm run test \${x:=\\$\\(touch ${four}\\)} \${x@P}` });
			expect(existsSync(three)).toBe(true);
			expect(existsSync(four)).toBe(true);
		});
	});

	describe("H1, A1: safe mode writes files", () => {
		it.each([
			"cat <(touch f)",
			"echo x >& src.ts",
			"sort --out=src.ts a",
			"sort --compress-prog=./tool a",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion, not a template.
			"echo ${x:=\\$\\(touch f\\)} ${x@P}",
		])("the classifier no longer allows %s in safe or ask mode", (command) => {
			for (const mode of ["safe", "ask"] as const)
				expect(decide("bash", { command }, mode).effect, `${mode}: ${command}`).not.toBe("allow");
		});

		it("still allows the ordinary commands", () => {
			for (const command of ["cat a 2>&1", "ls >&2", "sort -r a", "cat <(ls)", "echo $HOME"])
				expect(decide("bash", { command }, "safe").effect, command).toBe("allow");
		});

		it.skipIf(!findBwrap())(
			"the sandbox mounts the project read-only in safe mode, whatever a rule allows",
			async () => {
				const run = async (mode: Mode) => {
					writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode, allow: ["bash(touch *)"] }));
					const { harness, call } = await session(mode, "Block this action once", false);
					const result = await call("bash", { command: "touch witness /tmp/scratch; echo status=$?" });
					return { result, written: existsSync(join(harness.tempDir, "witness")) };
				};
				const safe = await run("safe");
				expect(safe.result, safe.result).toMatch(/Read-only file system/);
				expect(safe.written).toBe(false);
				const ask = await run("ask");
				expect(ask.result).toContain("status=0");
				expect(ask.written).toBe(true);
			},
		);

		// fork: the classifier only protects the secret
		// files a command names; in safe mode the sandbox hides them from the command too.
		it.skipIf(!findBwrap())("the sandbox hides the project's secret files in safe mode only", async () => {
			const run = async (mode: Mode) => {
				const { harness, call } = await session(mode, "Block this action once");
				mkdirSync(join(harness.tempDir, "sub"), { recursive: true });
				writeFileSync(join(harness.tempDir, ".env"), `KEY=${CANARY}-env\n`);
				writeFileSync(join(harness.tempDir, "sub", "deploy.key"), `${CANARY}-key\n`);
				writeFileSync(join(harness.tempDir, "args"), "sub/deploy.key\n.env\n");
				return [
					await call("bash", { command: `grep -r ${CANARY} . ; echo status=$?` }),
					await call("bash", { command: "xargs -a args cat; echo status=$?" }),
				];
			};
			for (const result of await run("safe")) {
				expect(result, result).not.toContain(`${CANARY}-`);
				expect(result, result).toMatch(/Permission denied/);
				expect(result, result).toMatch(/is hidden by the sandbox/);
				expect(result, result).not.toMatch(/outside what the agent may read/);
			}
			const [grep] = await run("ask");
			expect(grep).toContain(`${CANARY}-env`);
		});
	});

	describe.skipIf(!findBwrap())("M1: an excluded command with a shell prefix", () => {
		it("runs outside the sandbox, as the question said", async () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { excludedCommands: ["touch"] } }));
			const { titles, call } = await session(
				"broad",
				(options) => options.find((o) => o.startsWith("Allow")),
				true,
				{ shellCommandPrefix: "true" },
			);
			const witness = join(home, "outside-witness");
			await call("bash", { command: `touch ${witness}` });
			expect(titles.join("\n")).toContain("runs outside the sandbox");
			// The sandbox hides nothing here but would refuse the write: only outside it does the file appear.
			expect(existsSync(witness)).toBe(true);
		});
	});

	describe("M5, M6, M7: what a question names and shows", () => {
		it("M6: forced and deleting pushes without -f ask as dangerous", () => {
			for (const command of [
				"git push origin +main",
				"git push --mirror origin",
				"git push origin :main",
				"git push --delete origin main",
				"git push -uf origin main",
				"git -C repo push --force-with-lease origin main",
			])
				expect(decide("bash", { command }, "broad"), command).toMatchObject({ tier: "danger" });
			for (const command of ["git push origin main", "git push -u origin main", "git push origin HEAD:refs/heads/x"])
				expect(decide("bash", { command }, "broad").tier, command).not.toBe("danger");
		});

		it("M5: names the part no rule covers", () => {
			const { reason } = decidePermission("bash", { command: "npm run test; node evil.js" }, project, {
				mode: "ask",
				allow: ["bash(npm run*)"],
			});
			expect(reason).toContain("node");
			expect(reason).not.toMatch(/\bnpm\b/);
		});

		it("M7: the question shows a long command's end", async () => {
			const long = `echo ${"a".repeat(600)}; touch tail-marker`;
			const { titles, call } = await session("ask", "Block this action once");
			await call("bash", { command: long });
			expect(titles[0]).toContain("touch tail-marker");
			expect(titles[0]).not.toContain("[truncated]");
			const huge = `echo ${"b".repeat(9000)}; touch end`;
			expect(questionTarget(huge)).toMatch(/\[8296 characters not shown\][\s\S]*touch end$/);
		});
	});

	it("M4: a dangerous command hidden in a substitution, eval, a script or a git setting asks as dangerous", () => {
		for (const command of [
			"cat <(sudo id)",
			"ls >(sudo id)",
			"builtin eval 'sudo id'",
			'"$(echo sudo)" id',
			"git -ccore.pager=id log",
			`awk 'BEGIN{system("sudo id")}'`,
			"sed -n 'e sudo id' f",
			`python3 -c "__import__('os').system('sudo id')"`,
		])
			expect(decide("bash", { command }, "broad"), command).toMatchObject({ tier: "danger" });
		for (const command of [
			"awk '{print $1}' f",
			"sed -n 's/a/b/p' f",
			"git -c color.ui=always log",
			"python3 -c 'print(1)'",
		])
			expect(decide("bash", { command }, "broad").tier, command).not.toBe("danger");
	});
});
