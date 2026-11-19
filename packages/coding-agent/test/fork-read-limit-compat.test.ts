// fork: the matrix of § 9.2 replayed in Prism's real
// sandbox, proxy included, with reading limited to the project. Needs the network; run by
// fork/tools/read-limit-compat.sh, which prepares a throwaway home folder, never by ./test.sh.
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type TestContext, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { findBwrap, removeSessionTmpDir } from "../src/fork/sandbox/runtime.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

/** The throwaway home folder the script prepared, with the toolchains it found. */
const home = process.env.PRISM_COMPAT_HOME;
/** Where each scenario's result goes, one JSON line each. */
const out = process.env.PRISM_COMPAT_OUT;
/** `all` runs the same matrix without the limit, to tell its failures from the sandbox's own. */
const limit = process.env.PRISM_COMPAT_READ === "all" ? "all" : "project";

/** The hosts the scenarios reach, allowed without a question. */
const HOSTS = [
	"github.com",
	"registry.npmjs.org",
	"pypi.org",
	"files.pythonhosted.org",
	"index.crates.io",
	"static.crates.io",
	"crates.io",
];

describe.skipIf(!home || !out || !findBwrap())(
	"fork: reading limited to the project, compatibility (R3.16, lot 9)",
	() => {
		let agentDir: string;
		const harnesses: Harness[] = [];

		beforeAll(() => {
			agentDir = mkdtempSync(join(home!, "..", "agent-"));
			writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ sandbox: { read: { limit }, network: { allow: HOSTS, askNewHosts: false } } }),
			);
		});

		// Per test: Vitest restores the environment after each one.
		beforeEach(() => {
			vi.stubEnv(ENV_AGENT_DIR, agentDir);
			vi.stubEnv("HOME", home!);
			const tools = [".cargo/bin", ".local/npm/bin", ".bun/bin", ".local/bin", ".local/share/mise/shims"];
			vi.stubEnv(
				"PATH",
				[...tools.map((path) => join(home!, path)), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
			);
			for (const name of [
				"GIT_CONFIG_GLOBAL",
				"XDG_CONFIG_HOME",
				"RUSTUP_HOME",
				"CARGO_HOME",
				"NPM_CONFIG_USERCONFIG",
			])
				vi.stubEnv(name, undefined);
			for (const name of Object.keys(process.env))
				if (name.startsWith("npm_config_") || name.startsWith("NPM_CONFIG_")) vi.stubEnv(name, undefined);
		});

		afterEach(() => {
			for (const harness of harnesses.splice(0)) {
				removeSessionTmpDir(harness.sessionManager.getSessionId());
				harness.cleanup();
			}
			vi.unstubAllEnvs();
		});

		afterAll(() => {
			rmSync(agentDir, { recursive: true, force: true });
		});

		/** Runs `command` as the model would; `needs` are commands looked up in the PATH, or paths under ~. */
		async function run(context: TestContext, command: string, needs: string[] = []) {
			const found = (need: string) =>
				need.includes("/")
					? existsSync(join(home!, need))
					: process.env.PATH!.split(":").some((dir) => existsSync(join(dir, need)));
			const missing = needs.filter((need) => !found(need));
			if (missing.length > 0) {
				appendFileSync(out!, `${JSON.stringify({ scenario: context.task.name, result: "absent", missing })}\n`);
				context.skip(`not installed: ${missing.join(", ")}`);
			}
			const harness = await createHarness({
				extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
			});
			harnesses.push(harness);
			const questions: string[] = [];
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({
					// Answered as a user who allows the command; the questions are recorded with the scenario.
					select: async (title, options) => {
						questions.push(title.split("\n").at(-1)!);
						return options.find((option) => option.startsWith("Allow"));
					},
				}),
			});
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: `${command} && echo COMPAT-OK`, timeout: 600 }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			const started = Date.now();
			await harness.session.prompt("go");
			const text = getToolResult(harness, "bash")
				.content.map((part) => (part.type === "text" ? part.text : ""))
				.join("");
			const works = text.includes("COMPAT-OK");
			const lines = text.trim().split("\n");
			appendFileSync(
				out!,
				`${JSON.stringify({
					scenario: context.task.name,
					limit,
					result: works ? "works" : "fails",
					seconds: Math.round((Date.now() - started) / 1000),
					questions,
					...(works ? {} : { error: lines.filter((line) => line.trim()).slice(-12) }),
				})}\n`,
			);
			expect(works, text.slice(-4000)).toBe(true);
			return text;
		}

		it("git: clone over https, commit with the identity of ~/.gitconfig", async (context) => {
			await run(
				context,
				"git clone -q https://github.com/octocat/Hello-World.git hw && cd hw && echo x > new.txt && git add new.txt && git commit -qm compat && git log -1 --format=%an",
				["git"],
			);
		});

		it("npm: install a package, run the tests", async (context) => {
			await run(
				context,
				[
					"mkdir npmp && cd npmp && npm init -y >/dev/null",
					"npm install --no-audit --no-fund is-number@7.0.0 >/dev/null",
					`node -e 'require("fs").writeFileSync("test.js", "process.exit(require(\\"is-number\\")(5) ? 0 : 1)")'`,
					"npm pkg set scripts.test='node test.js' && npm test >/dev/null",
				].join(" && "),
				["npm", "node"],
			);
		});

		it("pnpm: version", async (context) => {
			await run(context, "pnpm --version", ["pnpm"]);
		});

		it("pip: venv, install from PyPI, pytest", async (context) => {
			await run(
				context,
				[
					"python3 -m venv .venv",
					".venv/bin/pip install -q pytest==8.3.3",
					"printf 'def test_ok():\\n    assert 1\\n' > test_ok.py",
					".venv/bin/pytest -q test_ok.py",
				].join(" && "),
				["python3"],
			);
		});

		it("uv: venv, install from PyPI, pytest", async (context) => {
			await run(
				context,
				[
					"mkdir uvp && cd uvp && uv venv -q",
					"uv pip install -q pytest==8.3.3",
					"printf 'def test_ok():\\n    assert 1\\n' > test_ok.py",
					".venv/bin/pytest -q test_ok.py",
				].join(" && "),
				["uv", "python3"],
			);
		});

		it("cargo: a dependency from crates.io, cargo test", async (context) => {
			await run(
				context,
				[
					"cargo new -q --vcs none cargop && cd cargop",
					"printf 'itoa = \"1\"\\n' >> Cargo.toml",
					"cargo test -q",
				].join(" && "),
				["cargo"],
			);
		});

		it("bun: version", async (context) => {
			await run(context, "bun --version", ["bun"]);
		});

		it("nvm: the installed Node version runs", async (context) => {
			await run(
				context,
				'. "$HOME/.nvm/nvm.sh" && nvm use --silent default && command -v node | grep -q "/.nvm/versions/"',
				[".nvm/nvm.sh"],
			);
		});

		it("pyenv: the installed Python version runs", async (context) => {
			await run(
				context,
				'export PATH="$HOME/.pyenv/bin:$PATH" && eval "$(pyenv init -)" && python -c "import sys; print(sys.prefix)" | grep -q "/.pyenv/versions/system-venv"',
				[".pyenv/bin/pyenv"],
			);
		});

		it("go: a module built and run", async (context) => {
			await run(
				context,
				[
					"mkdir gop && cd gop && go mod init example.com/gop >/dev/null 2>&1",
					"printf 'package main\\n\\nfunc main() { println(\"go-ok\") }\\n' > main.go",
					"go build && ./gop",
				].join(" && "),
				["go"],
			);
		});

		for (const tool of ["mise", "asdf"]) {
			it(`${tool}: version`, async (context) => {
				await run(context, `${tool} version || ${tool} --version`, [tool]);
			});
		}
	},
);
