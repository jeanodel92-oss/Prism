/**
 * fork: Git over SSH for sandboxed
 * commands. The sandbox has no network and no SSH agent, so `git-ssh-client.ts`, Git's SSH command in it, hands
 * the request to Prism, which runs the host's `ssh` for it. Only Git's own services pass, to a host the user
 * allowed (`ssh://<host>`): Prism builds the whole `ssh` command line itself, so nothing from the sandbox
 * becomes an option or a command of its own.
 */

import { execFile, spawn } from "node:child_process";
import type { Duplex } from "node:stream";
import type { CommandNetwork } from "./proxy.ts";
import { sshPlan } from "./ssh-provenance.ts";

/** The proxy request method of a Git SSH request; its target is the request, as base64url JSON. */
export const GIT_SSH_METHOD = "PRISM-GIT-SSH";

/** Frames from Prism to the client after the reply: type (u8), length (u32 BE), payload. */
export const FRAME_STDOUT = 1;
export const FRAME_STDERR = 2;
/** Payload: the exit code (u8). */
export const FRAME_EXIT = 3;

const SERVICES = new Set(["git-upload-pack", "git-receive-pack", "git-upload-archive"]);
const MAX_PATH = 4096;

export interface GitSshRequest {
	/** `host` or `user@host`, as Git passed it. */
	destination: string;
	port?: number;
	/** 4 or 6 when Git asked for one family (`-4`, `-6`). */
	family?: 4 | 6;
	/** Git's remote command: `git-upload-pack '<path>'`. */
	command: string;
	/** Git's `GIT_PROTOCOL` (`version=2`), sent with `SendEnv`. */
	protocol?: string;
}

export interface GitSshCommand {
	host: string;
	/** The `ssh` arguments, built by Prism. */
	args: string[];
	protocol?: string;
}

/** Undoes Git's shell quoting (`sq_quote_buf`): `'…'` runs joined by `\'` and `\!`; undefined otherwise. */
function unquote(quoted: string): string | undefined {
	let out = "";
	let rest = quoted;
	while (rest.length > 0) {
		const run = /^'([^']*)'/.exec(rest) ?? /^\\([!'])/.exec(rest);
		if (!run) return undefined;
		out += run[1];
		rest = rest.slice(run[0].length);
	}
	return quoted.length > 0 ? out : undefined;
}

/** Quotes as Git does, for the remote shell. */
const quote = (value: string) => `'${value.replace(/'/g, "'\\''").replace(/!/g, "'\\!'")}'`;

/** Checks a request from the sandbox and builds the `ssh` command line, or says why it is refused. */
export function gitSshCommand(request: GitSshRequest): GitSshCommand | string {
	// From the sandbox: any JSON, so the types are checked before anything reads them.
	const optional = (value: unknown, type: string) => value === undefined || typeof value === type;
	if (
		typeof request !== "object" ||
		request === null ||
		typeof request.destination !== "string" ||
		typeof request.command !== "string" ||
		!optional(request.port, "number") ||
		!optional(request.family, "number") ||
		!optional(request.protocol, "string")
	) {
		return "malformed request";
	}
	const destination = /^(?:([A-Za-z0-9._][A-Za-z0-9._-]*)@)?([A-Za-z0-9_][A-Za-z0-9._-]*)$/.exec(request.destination);
	if (!destination) return `not a host Prism passes to ssh: ${JSON.stringify(request.destination)}`;
	const [, user, host = ""] = destination;
	const command = /^(git-[a-z-]+) (.+)$/s.exec(request.command);
	const service = command?.[1];
	if (!command || !service || !SERVICES.has(service)) {
		return `only Git's own commands (${[...SERVICES].join(", ")}) run over SSH from the sandbox`;
	}
	const path = unquote(command[2]!);
	if (path === undefined || path.length === 0 || path.length > MAX_PATH || /[\u0000-\u001f\u007f]/.test(path)) {
		return "the repository path is not one Prism passes to ssh";
	}
	const port = request.port;
	if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) return "invalid port";
	const family = request.family;
	// Checked exactly: `-${family}` is an ssh option, so anything else would become one of the sandbox's.
	if (family !== undefined && family !== 4 && family !== 6) return "invalid address family";
	const protocol = request.protocol;
	if (protocol !== undefined && !/^[A-Za-z0-9=:._-]{1,64}$/.test(protocol)) return "invalid GIT_PROTOCOL";
	return {
		host: host.toLowerCase(),
		args: [
			// No prompt can reach the user from here: a key needs the agent, a new host key fails.
			"-o",
			"BatchMode=yes",
			...(protocol ? ["-o", "SendEnv=GIT_PROTOCOL"] : []),
			...(port ? ["-p", String(port)] : []),
			...(family ? [`-${family}`] : []),
			"--",
			user ? `${user}@${host}` : host,
			`${service} ${quote(path)}`,
		],
		protocol,
	};
}

/** The policy name of Git over SSH to `host`: allowed apart from the host's HTTPS. */
export const gitSshName = (host: string) => `ssh://${host.toLowerCase()}`;

/** The host of an `ssh://<host>` policy name, or undefined. */
export function gitSshHostOf(name: string): string | undefined {
	return /^ssh:\/\/([A-Za-z0-9_][A-Za-z0-9._-]*)$/i.exec(name)?.[1]?.toLowerCase();
}

function frame(type: number, payload: Buffer): Buffer {
	const header = Buffer.alloc(5);
	header.writeUInt8(type, 0);
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, payload]);
}

function refuse(stream: Duplex, status: string, message: string): void {
	const body = `Prism's sandbox refused Git over SSH: ${message}\n`;
	stream.end(`HTTP/1.1 ${status}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

/**
 * The host `ssh -G` says it would connect to, and whether a jump host or a proxy command stands in between. When
 * `ssh -G` fails, the requested host, unproxied: it is checked as it is.
 */
function sshTarget(program: string, args: string[], host: string): Promise<{ hostname: string; proxied: boolean }> {
	return new Promise((resolve) => {
		execFile(program, args, { cwd: "/", timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
			if (error) return resolve({ hostname: host, proxied: false });
			const value = (key: string) => new RegExp(`^${key} (.+)$`, "m").exec(stdout)?.[1]?.trim();
			const proxied = ["proxyjump", "proxycommand"].some((key) => {
				const found = value(key);
				return found !== undefined && found.toLowerCase() !== "none";
			});
			resolve({ hostname: value("hostname") ?? host, proxied });
		});
	});
}

/** Serves one Git SSH request: the stream carries ssh's input one way, its framed output the other. */
export async function serveGitSsh(
	stream: Duplex,
	target: string,
	rest: Buffer,
	network: CommandNetwork,
	sshProgram = "ssh",
): Promise<void> {
	let request: GitSshRequest;
	try {
		request = JSON.parse(Buffer.from(target, "base64url").toString("utf8")) as GitSshRequest;
	} catch {
		return refuse(stream, "400 Bad Request", "malformed request");
	}
	const command = gitSshCommand(request);
	if (typeof command === "string") return refuse(stream, "403 Forbidden", command);
	// Nothing ssh reads may come from the sandbox: checked before the question, which it would make pointless.
	const plan = network.sandboxWrites
		? sshPlan(network.sandboxWrites, sshProgram)
		: "Prism does not know what this command may write";
	if (typeof plan === "string") return refuse(stream, "403 Forbidden", plan);
	const name = gitSshName(command.host);
	if (!(await network.allows(name))) {
		return refuse(stream, "403 Forbidden", `${name} is not allowed. Ask the user to allow it.`);
	}
	// The command ended while the user was asked: nothing would ever stop this ssh.
	if (stream.destroyed) return;
	// fork: ssh resolves the name itself, so the addresses the proxy checks for a
	// connection are checked here, for the host ssh's configuration names. Through a jump host or a proxy command,
	// the name is resolved there, not here.
	const resolved = await sshTarget(plan.program, [...plan.options, "-G", ...command.args.slice(0, -1)], command.host);
	if (!resolved.proxied) {
		const why = await network.reachesResolved(name, resolved.hostname);
		if (why !== undefined) return refuse(stream, "403 Forbidden", why);
		if (stream.destroyed) return;
	}
	// Detached: ssh gets no terminal of Prism's to ask on, and BatchMode leaves it nothing to ask.
	// From /: a relative path in the user's configuration never resolves into the project.
	const child = spawn(plan.program, [...plan.options, ...command.args], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: "/",
		detached: true,
		env: { ...process.env, ...(command.protocol ? { GIT_PROTOCOL: command.protocol } : {}) },
	});
	const untrack = network.track(name, () => {
		child.kill("SIGTERM");
		stream.destroy();
	});
	stream.on("error", () => child.kill("SIGTERM"));
	stream.on("close", () => {
		if (child.exitCode === null) child.kill("SIGTERM");
	});
	child.on("error", (error) => {
		untrack();
		if (stream.writableEnded) return;
		stream.write(frame(FRAME_STDERR, Buffer.from(`Prism could not run ssh: ${error.message}\n`)));
		stream.end(frame(FRAME_EXIT, Buffer.from([255])));
	});
	stream.write("HTTP/1.1 200 OK\r\n\r\n");
	child.stdout.on("data", (chunk: Buffer) => {
		if (!stream.write(frame(FRAME_STDOUT, chunk))) child.stdout.pause();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		if (!stream.write(frame(FRAME_STDERR, chunk))) child.stderr.pause();
	});
	stream.on("drain", () => {
		child.stdout.resume();
		child.stderr.resume();
	});
	child.stdin.on("error", () => {});
	if (rest.length) child.stdin.write(rest);
	stream.pipe(child.stdin);
	stream.resume();
	child.on("close", (code, signal) => {
		untrack();
		if (!stream.writableEnded) stream.end(frame(FRAME_EXIT, Buffer.from([code ?? (signal ? 255 : 0)])));
	});
}
