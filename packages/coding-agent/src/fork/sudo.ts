/**
 * fork: `sudo`, a dedicated tool, off by default. Each call runs
 * one program, given as its arguments (no shell), as root and outside the sandbox, after the user confirms that
 * exact command and types the password in a masked field. D11 permits session approval and opt-in
 * reuse for five minutes in Prism's memory. The password goes to sudo through a one-shot
 * `SUDO_ASKPASS` helper reading a FIFO: never through the model, the session, the logs, an environment variable or
 * a file with content. `-k` makes sudo ignore and not update its cached credentials, and `sudo -k` runs after the
 * call anyway, so sudo itself keeps no credentials.
 */

import { execFile, spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionAPI } from "../core/extensions/types.ts";
import { descendantGroups, groupAlive } from "./child-process.ts";
import { fill, t } from "./i18n/index.ts";
import { hasInteractiveClient } from "./interactive-client.ts";
import { within } from "./path-within.ts";
import { configurationMode, sudoSessionApproved } from "./permissions.ts";
import { readSandboxSettings, sandboxSettingsProblem, subscribeSandboxSettings } from "./sandbox/layout.ts";
import { visibleText } from "./visible-text.ts";

export const SUDO_TOOL = "sudo";

/** Where programs are looked up: the system's own folders, never the user's PATH or the project. */
export const TRUSTED_PATH = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];

/** The machine, as the tool sees it; tests replace it (sudo itself is tested only in a throwaway VM). */
export interface SudoSystem {
	/** The setuid-root sudo binary, or why there is none to use. */
	sudo(): { path: string } | { error: string };
	/** The current user's id. */
	uid(): number;
	/** A private folder for the askpass helper (0700), on a file system that can run it. */
	runtimeDir(): string;
}

function findInTrustedPath(name: string): string | undefined {
	for (const dir of TRUSTED_PATH) {
		const path = join(dir, name);
		try {
			const stat = statSync(path);
			if (stat.isFile() && (stat.mode & 0o111) !== 0) return path;
		} catch {
			// Not in this folder.
		}
	}
	return undefined;
}

export const realSystem: SudoSystem = {
	sudo() {
		const path = findInTrustedPath("sudo");
		if (!path) return { error: "sudo is not installed in the system's folders." };
		const stat = statSync(realpathSync(path));
		// A sudo the user could replace, or one without the setuid bit, would not be the system's.
		if (stat.uid !== 0 || (stat.mode & 0o4000) === 0)
			return { error: `${path} is not owned by root with the setuid bit; Prism does not run it.` };
		return { path };
	},
	uid: () => process.getuid?.() ?? -1,
	runtimeDir() {
		const runtime = process.env.XDG_RUNTIME_DIR;
		return runtime && isAbsolute(runtime) && existsSync(runtime) ? runtime : tmpdir();
	},
};

/** Whether the current user can change `path`: the file itself, or a folder on its way (a rename replaces it). */
function userCanChange(path: string, uid: number): boolean {
	let current = path;
	for (;;) {
		try {
			const stat = statSync(current);
			if (stat.uid === uid && uid !== 0) return true;
			accessSync(current, constants.W_OK);
			// Writable but sticky (as /tmp): only its owner may rename a file in it.
			if (current === path || (stat.mode & 0o1000) === 0) return true;
		} catch {
			// Not writable by this user: check the folder above.
		}
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

export interface ResolvedCommand {
	/** The program sudo runs, absolute and with links resolved. */
	program: string;
	argv: string[];
	/** Arguments naming files the user or the project can change: root reads or runs them as they are then. */
	changeable: string[];
}

/**
 * The program `argv[0]` names, found in {@link TRUSTED_PATH} (or given as a path), or why it is refused. A program
 * the user or the project can change is refused: its content could change between the answer and the run.
 */
export function resolveCommand(argv: string[], cwd: string, system: SudoSystem): ResolvedCommand | { error: string } {
	const [name, ...args] = argv;
	if (!name) return { error: "No program given: argv is empty." };
	if (argv.some((arg) => arg.includes("\0"))) return { error: "An argument contains a NUL character." };
	let program: string | undefined;
	if (name.includes("/")) {
		const path = resolve(cwd, name);
		if (existsSync(path)) program = realpathSync(path);
	} else {
		const found = findInTrustedPath(name);
		if (found) program = realpathSync(found);
	}
	if (!program)
		return {
			error: `${name} was not found${name.includes("/") ? "" : ` in ${TRUSTED_PATH.join(":")}`}. Give an installed program.`,
		};
	const uid = system.uid();
	if (within(program, realpathSync(cwd)) || userCanChange(program, uid))
		return {
			error: `${program} can be changed by your user account or the project, so root would run whatever it contains at that moment. Prism runs only programs the system owns with sudo.`,
		};
	const changeable = args.filter((arg) => {
		if (arg.startsWith("-")) return false;
		const path = resolve(cwd, arg);
		return existsSync(path) && (within(realpathSync(path), realpathSync(cwd)) || userCanChange(path, uid));
	});
	return { program, argv: [program, ...args], changeable };
}

/** The command as the question shows it: each argument quoted when needed, so it reads as it runs. */
export function showCommand(argv: string[]): string {
	return argv.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** The environment sudo gets: a fixed PATH and the language, nothing from the session or the project. */
export function sudoEnv(askpass: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { PATH: TRUSTED_PATH.join(":"), SUDO_ASKPASS: askpass };
	for (const name of ["LANG", "LC_ALL"]) {
		const value = process.env[name];
		if (value && /^[\w.@-]+$/.test(value)) env[name] = value;
	}
	return env;
}

interface Askpass {
	helper: string;
	passwordRefused(): boolean;
	/** Hands the password to the helper's first run; a second run (a wrong password) gets nothing and fails. */
	deliver(password: string): Promise<void>;
	dispose(): void;
}

/** A one-shot helper in a private folder, reading the password from a FIFO that holds it only in transit. */
function createAskpass(system: SudoSystem): Askpass {
	const dir = mkdtempSync(join(system.runtimeDir(), "prism-sudo-"));
	const fifo = join(dir, "password");
	const helper = join(dir, "askpass");
	const refused = join(dir, "refused");
	const mkfifo = findInTrustedPath("mkfifo");
	const cat = findInTrustedPath("cat");
	const sh = findInTrustedPath("sh");
	if (!mkfifo || !cat || !sh) {
		rmSync(dir, { recursive: true, force: true });
		throw new Error("mkfifo, cat or sh is missing from the system's folders.");
	}
	const made = spawnSync(mkfifo, ["-m", "600", fifo], { env: { PATH: TRUSTED_PATH.join(":") } });
	if (made.status !== 0) {
		rmSync(dir, { recursive: true, force: true });
		throw new Error(`Could not create the password channel: ${made.stderr.toString().trim()}`);
	}
	// The FIFO is removed once read: a second run (sudo retrying after a wrong password) fails at once.
	writeFileSync(
		helper,
		`#!${sh}\numask 077\n[ -p ${showCommand([fifo])} ] || { : > ${showCommand([refused])}; exit 1; }\nexec ${cat} ${showCommand([fifo])}\n`,
		{
			mode: 0o700,
		},
	);
	let pending: Promise<void> | undefined;
	return {
		helper,
		passwordRefused: () => existsSync(refused),
		deliver(password) {
			pending = (async () => {
				// Opening for writing waits for the helper to open it for reading.
				const handle = await open(fifo, "w");
				// Removed while both ends are open, before the helper can see the end of the password: its next run
				// (sudo retrying) finds no FIFO however late this process gets back to it. Removed after the close, a
				// busy event loop let the retry open the FIFO again and wait for a writer until the command's timeout.
				rmSync(fifo, { force: true });
				try {
					const bytes = Buffer.from(`${password}\n`, "utf8");
					await handle.write(bytes);
					bytes.fill(0);
				} finally {
					await handle.close();
				}
			})();
			return pending;
		},
		dispose() {
			// sudo never asked (a rule without password): open the reading end so the pending write ends here.
			if (existsSync(fifo)) {
				spawnSync(cat, [fifo], { stdio: "ignore", timeout: 2000 });
			}
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

export interface SudoRun {
	exitCode: number | null;
	/** sudo retried the one-shot helper after refusing the password. */
	passwordRefused: boolean;
	output: string;
	timedOut: boolean;
	aborted: boolean;
	/**
	 * sudo had not ended a while after the stop, or processes of the command's groups still ran: what it runs may
	 * still be running as root.
	 */
	unconfirmedStop: boolean;
}

const MAX_OUTPUT = 64 * 1024;
/** After SIGTERM, how long root's `timeout` waits before SIGKILL to the command's process group. */
const KILL_AFTER_S = 5;
/** How long, after the stop, Prism waits for sudo to end before it returns without that proof. */
const STOP_WAIT_MS = (KILL_AFTER_S + 5) * 1000;
/**
 * fork: after a stop, how long the command's process groups may take to
 * empty. GNU timeout sends SIGKILL only while the command itself runs: a descendant that ignores SIGTERM outlives a
 * command that quits on it, and sudo's end proves nothing about it.
 */
const GROUP_WAIT_MS = (KILL_AFTER_S + 2) * 1000;

/**
 * Runs `command` with sudo, outside the sandbox, as root. The caller has the user's approval and password; this
 * never shows them anywhere. Cached credentials are ignored (`-k`) and cleared afterwards (`sudo -k`).
 *
 * The user's account cannot signal a root process, and a SIGKILL to sudo would orphan the command, so the stop is
 * root's own: sudo runs the system's `timeout`, which puts the command in its own process group, sends SIGTERM to
 * that group at the limit or when sudo relays the cancel, and SIGKILL `KILL_AFTER_S` later. A process the command
 * detached from its group (setsid, a daemon) is beyond it; the result says so.
 */
export async function runSudo(
	command: ResolvedCommand,
	password: string,
	cwd: string,
	options: { system: SudoSystem; timeoutMs: number; signal?: AbortSignal },
): Promise<SudoRun | { error: string }> {
	const sudo = options.system.sudo();
	if ("error" in sudo) return sudo;
	const limiter = resolveCommand([findInTrustedPath("gnutimeout") ?? "timeout"], cwd, options.system);
	if ("error" in limiter) return { error: `timeout (coreutils) is needed to stop the command: ${limiter.error}` };
	// Ubuntu's uutils timeout can leave the command's children alive after cancellation.
	const version = await new Promise<string>((resolve) => {
		execFile(
			limiter.program,
			["--version"],
			{ env: { PATH: TRUSTED_PATH.join(":") }, timeout: 1000, maxBuffer: 4096, signal: options.signal },
			(error, stdout) => resolve(error ? "" : stdout),
		);
	});
	if (!version.startsWith("timeout (GNU coreutils)"))
		return {
			error: "GNU coreutils timeout is needed to stop sudo's whole process group. Install gnu-coreutils (gnutimeout) or select GNU timeout. Nothing ran.",
		};
	const seconds = Math.max(1, Math.ceil(options.timeoutMs / 1000));
	const askpass = createAskpass(options.system);
	const env = sudoEnv(askpass.helper);
	try {
		const delivered = askpass.deliver(password).catch(() => {});
		const result = await new Promise<SudoRun>((done) => {
			const child = spawn(
				sudo.path,
				["-k", "-A", "--", limiter.program, `--kill-after=${KILL_AFTER_S}s`, `${seconds}s`, ...command.argv],
				{ cwd, env, stdio: ["ignore", "pipe", "pipe"] },
			);
			let output = "";
			const add = (chunk: Buffer) => {
				output += chunk.toString("utf8");
				if (output.length > MAX_OUTPUT * 2) output = output.slice(-MAX_OUTPUT);
			};
			child.stdout.on("data", add);
			child.stderr.on("data", add);
			let timedOut = false;
			let aborted = false;
			let giveUp: NodeJS.Timeout | undefined;
			let finished = false;
			const finish = (exitCode: number | null, unconfirmedStop: boolean, extra = "") => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				clearTimeout(giveUp);
				options.signal?.removeEventListener("abort", abort);
				// A detached process may hold the pipes open: stop reading them rather than wait.
				child.stdout.destroy();
				child.stderr.destroy();
				done({
					exitCode,
					// A one-attempt sudo policy never retries askpass; sudo's own errors also forget the password.
					passwordRefused: askpass.passwordRefused() || (exitCode === 1 && /^sudo:/m.test(output)),
					output: (output + extra).slice(-MAX_OUTPUT),
					timedOut,
					aborted,
					unconfirmedStop,
				});
			};
			// fork: the command's process groups, read when it is stopped, and watched until empty.
			let stoppedAt: number | undefined;
			let watched: number[] = [];
			let settling = false;
			const settle = (exitCode: number | null) => {
				if (settling) return;
				settling = true;
				if (stoppedAt === undefined || watched.length === 0) return finish(exitCode, false);
				const deadline = stoppedAt + GROUP_WAIT_MS;
				const check = () => {
					if (finished) return;
					if (!watched.some(groupAlive)) return finish(exitCode, false);
					if (Date.now() >= deadline) return finish(exitCode, true);
					setTimeout(check, 100);
				};
				check();
			};
			const stop = () => {
				if (stoppedAt === undefined) {
					stoppedAt = Date.now();
					if (child.pid) watched = descendantGroups(child.pid);
				}
				child.kill("SIGTERM");
				giveUp ??= setTimeout(() => finish(null, true), STOP_WAIT_MS);
			};
			const timer = setTimeout(() => {
				timedOut = true;
				stop();
			}, options.timeoutMs);
			const abort = () => {
				aborted = true;
				stop();
			};
			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
			child.on("error", (error) => finish(null, false, String(error)));
			child.on("exit", (code) => {
				// The rest of the output, unless something detached keeps the pipes open.
				let closed = false;
				child.once("close", () => {
					closed = true;
					settle(code);
				});
				setTimeout(() => {
					if (!closed) settle(code);
				}, 1000);
			});
		});
		// Unblocks a write sudo never read (a rule without password) before waiting for it.
		askpass.dispose();
		await delivered;
		return result;
	} finally {
		askpass.dispose();
		// No credential outlives the call, whatever happened.
		spawnSync(sudo.path, ["-k"], { env: { PATH: TRUSTED_PATH.join(":") }, stdio: "ignore", timeout: 5000 });
	}
}

export const SUDO_ANSWER_TIMEOUT_MS = 120_000;
const SUDO_RUN_TIMEOUT_MS = 10 * 60_000;
const SUDO_PASSWORD_MS = 5 * 60_000;

const parameters = Type.Object(
	{
		argv: Type.Array(Type.String(), {
			minItems: 1,
			description: 'The program and its arguments, one item each, as in ["dnf", "install", "-y", "git"]. No shell.',
		}),
	},
	{ additionalProperties: false },
);

/** The question the user answers, with the password: everything root will run, and where. */
export function sudoQuestion(command: ResolvedCommand, cwd: string): string {
	return [
		t("Run as root, outside the sandbox?"),
		// fork.12 security audit (AS-016, AS-017): the arguments show their terminal controls and line breaks.
		visibleText(showCommand(command.argv)),
		`${t("Folder:")} ${cwd}`,
		command.changeable.length > 0
			? fill(
					"Warning: your account or the project can change {0}; root uses it as it is when the command runs.",
					visibleText(command.changeable.join(", ")),
				)
			: "",
		t("Type your password to allow this command once, or press Escape to refuse."),
	]
		.filter(Boolean)
		.join("\n\n");
}

/** fork (SEC-04): the tool, registered only when the user turned it on (`sandbox.sudo`, /settings). */
export function sudoExtension(system: SudoSystem = realSystem, now: () => number = Date.now) {
	return (pi: ExtensionAPI): void => {
		// settings that cannot be read leave the tool off.
		if (sandboxSettingsProblem() || !readSandboxSettings().sudo) return;
		let remembered: { password: string; until: number } | undefined;
		let expiry: NodeJS.Timeout | undefined;
		let generation = 0;
		const forget = () => {
			remembered = undefined;
			clearTimeout(expiry);
			generation++;
		};
		const checkSettings = () => {
			const settings = readSandboxSettings();
			if (!settings.sudo || !settings.sudoRememberPassword) forget();
		};
		let unsubscribe: (() => void) | undefined;
		pi.on("session_start", () => {
			forget();
			unsubscribe?.();
			unsubscribe = subscribeSandboxSettings(checkSettings);
		});
		pi.on("session_shutdown", () => {
			forget();
			unsubscribe?.();
			unsubscribe = undefined;
		});
		pi.on("before_agent_start", checkSettings);
		pi.registerTool({
			name: SUDO_TOOL,
			label: "sudo",
			permissions: ["privilege"],
			description:
				"Run one installed program as root, outside the sandbox, with sudo. The user approves the exact command or allows sudo for this session. A masked field asks for the password unless the user opted to remember it in Prism's memory for five minutes. Interactive UI only; refused in safe mode. No shell: pipes, redirections and && do not work.",
			promptSnippet: "Run one program as root with the user's approval and password",
			promptGuidelines: [
				"Use sudo only for what needs administrator rights (installing system packages, changing system files or services). Give the program and its arguments in argv; there is no shell.",
				"Never ask the user for their password in the conversation: the sudo tool asks for it itself. If the user refuses, do not retry the same command or work around it.",
			],
			parameters,
			async execute(_id, params, signal, _onUpdate, ctx) {
				checkSettings();
				if (remembered && remembered.until <= now()) forget();
				if (!hasInteractiveClient(ctx))
					throw new Error(
						"sudo needs the user at the terminal or the Prism window. Print, scheduled runs and RPC clients without dialogs are refused.",
					);
				const mode = configurationMode(ctx);
				if (mode === undefined || mode === "safe") throw new Error("sudo is refused in safe mode.");
				if (!Check(parameters, params)) throw new Error("Invalid argv: a list of strings, the program first.");
				const sudo = system.sudo();
				if ("error" in sudo) throw new Error(sudo.error);
				const command = resolveCommand(params.argv, ctx.cwd, system);
				if ("error" in command) throw new Error(command.error);
				const reused = remembered !== undefined;
				const currentGeneration = generation;
				const password =
					remembered?.password ??
					(await ctx.ui.input(sudoQuestion(command, ctx.cwd), t("Password"), {
						secret: true,
						timeout: SUDO_ANSWER_TIMEOUT_MS,
						signal,
					}));
				const until = remembered?.until ?? now() + SUDO_PASSWORD_MS;
				if (signal?.aborted || password === undefined || password === "")
					throw new Error("The user did not allow this command. Nothing ran. Do not retry it or work around it.");
				// fork: safe mode chosen while the password was asked refuses the command.
				const modeNow = configurationMode(ctx);
				if (modeNow === undefined || modeNow === "safe")
					throw new Error("sudo is refused in safe mode, chosen while the password was asked. Nothing ran.");
				// Checked again: the program may have changed while the question was open.
				const again = resolveCommand(params.argv, ctx.cwd, system);
				if ("error" in again || again.program !== command.program)
					throw new Error("The program changed while waiting. Nothing ran.");
				const run = await runSudo(command, password, ctx.cwd, { system, timeoutMs: SUDO_RUN_TIMEOUT_MS, signal });
				if ("error" in run) {
					forget();
					throw new Error(run.error.split(password).join("***"));
				}
				checkSettings();
				if (run.passwordRefused || run.exitCode === null) forget();
				else if (
					!reused &&
					generation === currentGeneration &&
					readSandboxSettings().sudoRememberPassword &&
					until > now()
				) {
					remembered = { password, until };
					clearTimeout(expiry);
					expiry = setTimeout(forget, until - now());
					expiry.unref();
				}
				const output = run.output.split(password).join("***").trim();
				const stopped = run.timedOut ? "Stopped after 10 minutes" : "Cancelled";
				const status = run.unconfirmedStop
					? `${stopped}, but its end was not confirmed (sudo, or processes of the command's process group, still ran several seconds later): the command or what it started may still be running as root.`
					: run.timedOut || run.aborted
						? `${stopped}: the command and its process group were ended (SIGTERM, then SIGKILL). A process it detached from its group may still be running as root.`
						: run.exitCode === 0
							? "Done."
							: `Exit code ${run.exitCode ?? "none"}.`;
				// The result is read by the model: English; the user gets the same notice in their language.
				const notice = reused
					? sudoSessionApproved(ctx)
						? "Root command: remembered password and session approval."
						: "Root command: remembered password and approval for this call."
					: "";
				if (notice) ctx.ui.notify(t(notice), "warning");
				const text = [notice, output, status].filter(Boolean).join("\n\n");
				if (run.exitCode !== 0) throw new Error(text);
				return { content: [{ type: "text", text }], details: { exitCode: run.exitCode } };
			},
		});
	};
}
