/**
 * fork: through the real CLI, a key held in the
 * keyring and a key in Prism's environment reach the provider, while the sandboxed commands cannot read them (`env`,
 * `auth.json`, `/proc`) and no file Prism writes holds them: session, export, trace, background logs, undo snapshots,
 * `prism doctor`. A fake `secret-tool` and `gdbus` stand for the keyring: no test reaches a real one.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { findBwrap } from "../src/fork/sandbox/runtime.ts";
import { forgetKeyringCredentials } from "../src/fork/secrets/keyring.ts";

const FAKE_SECRET_TOOL = `#!/bin/sh
cmd=$1; shift
[ "$cmd" = store ] && shift
item="$FAKE_KEYRING/$(printf '%s ' "$@" | sha1sum | cut -c1-40)"
case $cmd in
	store) cat > "$item" ;;
	lookup) [ -f "$item" ] || exit 1; cat "$item" ;;
	clear) rm -f "$item" ;;
esac
`;

const FAKE_GDBUS = `#!/bin/sh
case "$*" in
	*ListActivatableNames*) echo "(['org.freedesktop.DBus', 'org.freedesktop.secrets'],)" ;;
	*NameHasOwner*) echo "(true,)" ;;
esac
`;

/** Both keys share this marker, which the commands look for: a count, so that masking cannot hide a leak. */
const MARK = "e2e-canary";
const KEYRING_KEY = `sk-${MARK}-keyring-0123456789`;
const ENV_KEY = `sk-${MARK}-env-0123456789`;
/** A key saved before the keyring, still in clear in auth.json. */
const PLAIN_KEY = `sk-${MARK}-plain-0123456789`;
/** Matches the marker without holding it, so that a probe's own command line (`/proc/<pid>/cmdline`) never counts. */
const MARK_RE = "e2e-[c]anary";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fakeProvider = resolve(packageDir, "../../fork/tools/fake-provider.ts");

let root: string;
let agentDir: string;
let cwd: string;
let env: NodeJS.ProcessEnv;
let prism: string;

/** Every file under `folder` whose bytes hold `needle`, or that cannot be read and is not empty. */
function filesHolding(folder: string, needle: string): string[] {
	if (!existsSync(folder)) return [];
	const found: string[] = [];
	for (const name of readdirSync(folder)) {
		const path = join(folder, name);
		const stat = statSync(path);
		if (stat.isDirectory()) found.push(...filesHolding(path, needle));
		else if (!stat.isFile()) continue;
		else if (stat.mode & 0o444) {
			if (readFileSync(path).includes(needle)) found.push(path);
		}
		// An unreadable file must be one of the sandbox's empty masks.
		else if (stat.size > 0) found.push(`${path} (unreadable)`);
	}
	return found;
}

function run(args: string[]): Promise<{ code: number | null; output: string }> {
	return new Promise((done) => {
		const child = spawn(process.execPath, [...nodeArgs(), ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk;
		});
		child.on("close", (code) => done({ code, output }));
	});
}

const nodeArgs = () => ["--import", pathToFileURL(join(packageDir, "src/experimental/source-resolver.ts")).href, prism];

/** Runs `prompts` in RPC mode, then exports the session to `exportPath`; returns everything the CLI printed. */
async function rpc(prompts: string[], exportPath: string): Promise<string> {
	const child: ChildProcess = spawn(
		process.execPath,
		[...nodeArgs(), "--mode", "rpc", "-e", fakeProvider, "--provider", "fake", "--model", "scripted"],
		{ cwd, env, stdio: ["pipe", "pipe", "pipe"] },
	);
	let printed = "";
	const send = (record: unknown) => child.stdin!.write(`${JSON.stringify(record)}\n`);
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			new Promise<void>((done, fail) => {
				let buffer = "";
				child.once("close", (code) => fail(new Error(`CLI exited early (${code})\n${printed}`)));
				child.stderr!.on("data", (chunk: Buffer) => {
					printed += chunk;
				});
				child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
					printed += chunk;
					buffer += chunk;
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						if (!line.startsWith("{")) continue;
						const record = JSON.parse(line) as { type?: string; command?: string; method?: string; id?: string };
						if (record.type === "agent_settled") {
							const next = prompts.shift();
							send(next ? { type: "prompt", message: next } : { type: "export_html", outputPath: exportPath });
						}
						if (record.type === "response" && record.command === "export_html") done();
						// No question is expected (broad mode); one left unanswered would stall the run.
						if (record.type === "extension_ui_request" && record.method === "select")
							fail(new Error(`unexpected question\n${line}`));
					}
				});
				send({ type: "prompt", message: prompts.shift() });
			}),
			new Promise<never>((_done, fail) => {
				timer = setTimeout(() => fail(new Error(`CLI timeout\n${printed}`)), 90_000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		child.kill("SIGKILL");
	}
	return printed;
}

const steps = (calls: Array<[string, Record<string, unknown>]>) => `steps ${JSON.stringify(calls)}`;
const bash = (command: string): [string, Record<string, unknown>] => ["bash", { command }];
/** Prints `<label>=<number of lines holding the marker>`. */
const count = (label: string, source: string) =>
	bash(`echo ${label}=$( { ${source}; } 2>/dev/null | grep -c '${MARK_RE}')`);

describe("secrets end to end through the real CLI", () => {
	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "prism-secrets-e2e-"));
		agentDir = join(root, "agent");
		cwd = join(root, "work");
		const bin = join(root, "bin");
		const packageRoot = join(root, "package");
		for (const folder of [agentDir, cwd, bin, join(root, "keyring"), join(packageRoot, "bin")])
			mkdirSync(folder, { recursive: true });
		for (const [name, script] of [
			["secret-tool", FAKE_SECRET_TOOL],
			["gdbus", FAKE_GDBUS],
		] as const) {
			writeFileSync(join(bin, name), script);
			chmodSync(join(bin, name), 0o755);
		}
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({ type: "module", piConfig: { name: "prism", configDir: ".prism" } }),
		);
		for (const name of ["src", "docs", "examples", "vendor"])
			symlinkSync(join(packageDir, name), join(packageRoot, name), "dir");
		prism = join(packageRoot, "bin", "prism");
		writeFileSync(prism, `import ${JSON.stringify(pathToFileURL(join(packageDir, "src/cli.ts")).href)};\n`);

		env = {
			...process.env,
			HOME: root,
			PATH: `${bin}:${process.env.PATH}`,
			FAKE_KEYRING: join(root, "keyring"),
			FAKE_KEY_DIGEST: join(root, "key-digests"),
			FAKE_PLAIN: "1",
			DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/fake-bus",
			PRISM_SECRET_SERVICE: "",
			PRISM_E2E_API_KEY: ENV_KEY,
			PI_PACKAGE_DIR: packageRoot,
			PI_CODING_AGENT_DIR: agentDir,
			PRISM_CODING_AGENT_DIR: agentDir,
			[ENV_AGENT_DIR]: agentDir,
			PI_OFFLINE: "1",
		};
		// The key is saved as a new connection is: into the keyring, auth.json keeping a marker.
		for (const name of ["PATH", "FAKE_KEYRING", "DBUS_SESSION_BUS_ADDRESS", "PRISM_SECRET_SERVICE"])
			vi.stubEnv(name, env[name]);
		await AuthStorage.create(join(agentDir, "auth.json")).modify("fake", async () => ({
			type: "api_key",
			key: KEYRING_KEY,
		}));
		forgetKeyringCredentials();
		vi.unstubAllEnvs();
		const authPath = join(agentDir, "auth.json");
		expect(readFileSync(authPath, "utf8")).not.toContain(MARK);
		const saved = JSON.parse(readFileSync(authPath, "utf8"));
		writeFileSync(authPath, JSON.stringify({ ...saved, legacy: { type: "api_key", key: PLAIN_KEY } }));
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		writeFileSync(join(cwd, "notes.txt"), "first\n");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const sandboxes = findBwrap() ? ["on", "off"] : ["off"];
	it.each(sandboxes)(
		"keeps both keys out of commands and files, and gives them to the provider (sandbox %s)",
		async (sandbox) => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					traceEnabled: true,
					sandbox: { modes: { broad: sandbox === "on" } },
					secrets: { passEnv: { PRISM_E2E_API_KEY: ["bash(printenv PRISM_E2E_API_KEY)"] } },
				}),
			);
			const exportPath = join(root, "export.html");
			const printed = await rpc(
				[
					steps([
						count("env", "env"),
						// The path is built when the command runs, so that only the sandbox, not the permission guard
						// reading the command, stands between the command and the file.
						count("auth", `cat "$(printf /%s ${agentDir.split("/").filter(Boolean).join(" ")})/auth.json"`),
						count("proc", "cat /proc/[0-9]*/environ /proc/[0-9]*/cmdline | tr '\\0' '\\n'"),
						// Passed by the user's rule: the command gets the key, the model and the files its masked name.
						bash("printenv PRISM_E2E_API_KEY"),
						["background", { action: "run", command: `env | grep -c '${MARK_RE}' > bg-count.txt; env` }],
						// Waits for the task here: the CLI is stopped once the steps are done.
						bash(
							"for i in $(seq 100); do [ -s bg-count.txt ] && break; sleep 0.1; done; sleep 0.5; echo bg=$(cat bg-count.txt)",
						),
						["write", { path: "notes.txt", content: "second\n" }],
						["edit", { path: "notes.txt", edits: [{ oldText: "second", newText: "third" }] }],
					]),
				],
				exportPath,
			);

			// The commands' own view, as counts: masking in tool results cannot hide a leak here.
			expect(printed).toContain("env=0");
			// Outside the sandbox, nothing stops a command reading auth.json: the reason for the keyring.
			expect(printed).toContain(sandbox === "on" ? "auth=0" : "auth=1");
			expect(printed).toContain("[secret hidden: PRISM_E2E_API_KEY]");
			// Outside the sandbox, Prism's own process is visible in /proc with its environment: a documented limit.
			expect(printed).toContain(sandbox === "on" ? "proc=0" : "proc=");
			if (sandbox === "off") expect(printed).not.toContain("proc=0");
			expect(printed).toContain("bg=0");
			expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("third\n");

			// The provider got the keyring's key on every request.
			const digests = readFileSync(join(root, "key-digests"), "utf8").trim().split("\n");
			expect(digests.length).toBeGreaterThan(0);
			expect(new Set(digests)).toEqual(new Set([digest(KEYRING_KEY)]));

			// `prism doctor`, shown and exported.
			const doctor = await run(["doctor", "details"]);
			expect(doctor.output).toContain("keyring: fake; auth.json: legacy");
			await run(["doctor", "export", join(root, "doctor.json")]);
			expect(existsSync(join(root, "doctor.json"))).toBe(true);

			// What Prism wrote or printed: session, export, trace, background logs, undo snapshots, doctor, RPC events.
			expect(existsSync(exportPath)).toBe(true);
			expect(readdirSync(join(agentDir, "traces")).length).toBeGreaterThan(0);
			expect(readdirSync(join(agentDir, "checkpoints")).length).toBeGreaterThan(0);
			expect(readdirSync(join(agentDir, "bg")).length).toBeGreaterThan(0);
			expect(filesHolding(agentDir, "e2e-canary-keyring")).toEqual([]);
			expect(filesHolding(agentDir, "e2e-canary-env")).toEqual([]);
			expect(filesHolding(agentDir, "e2e-canary-plain")).toEqual([join(agentDir, "auth.json")]);
			expect(filesHolding(cwd, MARK)).toEqual([]);
			for (const file of [exportPath, join(root, "doctor.json")])
				expect(readFileSync(file, "utf8")).not.toContain(MARK);
			expect(doctor.output).not.toContain(MARK);
			expect(printed).not.toContain(KEYRING_KEY);
			expect(printed).not.toContain(ENV_KEY);
			expect(printed).not.toContain(PLAIN_KEY);
		},
		180_000,
	);
});
