/**
 * fork: Git signs commits and tags from
 * the sandbox, where neither the key, `~/.gnupg` nor the SSH agent is. `git-sign-client.ts`, Git's `gpg.program`
 * and `gpg.ssh.program` there, sends the object to sign to Prism, which signs it here with the program and key of
 * the user's own Git configuration. Only a commit or a tag is signed, and an SSH signature only in Git's
 * namespace: nothing else the key vouches for (a login, a file, an e-mail) passes, and nothing is exported.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import type { CommandNetwork } from "./proxy.ts";
import { findProgram } from "./ssh-provenance.ts";

/** The proxy request method of a signing request; its target is the request, as base64url JSON, its body the object. */
export const GIT_SIGN_METHOD = "PRISM-GIT-SIGN";

export interface GitSignRequest {
	format: "openpgp" | "ssh";
	/** Git's working folder in the sandbox: its repository's configuration names the key. */
	cwd: string;
}

/** What the signing program printed, returned to Git as if it had run in the sandbox. */
export interface GitSignResult {
	exit: number;
	/** base64 */
	stdout: string;
	stderr: string;
	/** The SSH signature (`<file>.sig`), base64. */
	signature?: string;
}

/** A commit or a tag object as Git hands it to the signing program. Larger is refused. */
const MAX_OBJECT = 8 * 1024 * 1024;
const OBJECT_ID = "[0-9a-f]{40}(?:[0-9a-f]{24})?";
const COMMIT = new RegExp(`^tree ${OBJECT_ID}\\n(?:parent ${OBJECT_ID}\\n)*author [^\\n]+\\ncommitter ([^\\n]+)\\n`);
const TAG = new RegExp(`^object ${OBJECT_ID}\\ntype (?:commit|tree|blob|tag)\\ntag [^\\n]+\\ntagger ([^\\n]+)\\n`);
/** `Name <email>` of an ident line, without its date. */
const IDENT = /^([^\n<>-][^\n<>]* <[^\n<>]*>) \d+ [+-]\d{4}$/;

/** The identity a commit or tag is signed for, or undefined when the payload is neither. */
export function signedIdent(payload: string): string | undefined {
	const line = COMMIT.exec(payload)?.[1] ?? TAG.exec(payload)?.[1];
	return line === undefined ? undefined : (IDENT.exec(line)?.[1] ?? "");
}

/** One value of the user's Git configuration, with the file it came from. */
function gitConfig(git: string, cwd: string, name: string): { value: string; file?: string } | undefined {
	const result = spawnSync(git, ["config", "--includes", "--show-origin", "-z", "--get", name], {
		cwd,
		encoding: "utf8",
		timeout: 10_000,
	});
	if (result.status !== 0) return undefined;
	const [origin = "", value = ""] = result.stdout.split("\0");
	return { value, file: origin.startsWith("file:") ? origin.slice("file:".length) : undefined };
}

type Plan = { program: string; args: string[]; key?: string } | string;

/** The signing command of the user's configuration for this request, or why there is none. */
export function signingPlan(
	request: GitSignRequest,
	payload: string,
	writes: (path: string) => boolean,
	path = process.env.PATH ?? "",
): Plan {
	const git = findProgram("git", path);
	if (!git) return "Prism cannot find git to read your signing configuration";
	if (writes(git))
		return `Prism would read your Git configuration with ${git}, which commands in the sandbox can change`;
	// The repository's configuration, as Git in the sandbox read it: its folders are at the same paths here, but for
	// its private /tmp, where the user's configuration alone applies. Git names a repository's files from its top.
	let cwd = "/";
	try {
		if (statSync(request.cwd).isDirectory()) cwd = request.cwd;
	} catch {}
	cwd =
		spawnSync(git, ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 10_000 }).stdout?.trim() ||
		cwd;
	const settings = new Map<string, string>();
	for (const name of ["gpg.format", "user.signingkey", "gpg.program", "gpg.openpgp.program", "gpg.ssh.program"]) {
		const entry = gitConfig(git, cwd, name);
		if (!entry) continue;
		const file = entry.file === undefined ? undefined : resolve(cwd, entry.file);
		if (file && writes(file)) {
			return `${file} sets ${name}, and commands in the sandbox can change it`;
		}
		settings.set(name, entry.value);
	}
	const format = settings.get("gpg.format") ?? "openpgp";
	if (format !== request.format) {
		return `Git in the sandbox asked for an ${request.format} signature, but your Git configuration signs with ${format}`;
	}
	const ident = signedIdent(payload);
	if (ident === undefined) return "only Git commits and tags are signed from the sandbox";
	const configured = settings.get("user.signingkey");
	let program: string;
	let args: string[];
	let key: string | undefined;
	if (format === "openpgp") {
		program = settings.get("gpg.openpgp.program") ?? settings.get("gpg.program") ?? "gpg";
		// Without a key of its own, Git signs for the committer (or tagger), as it does here.
		const signer = configured ?? ident;
		if (!signer) return "no signing key: set user.signingkey in your Git configuration";
		args = ["--status-fd=2", "-bsau", signer];
	} else {
		program = settings.get("gpg.ssh.program") ?? "ssh-keygen";
		if (!configured) return "no SSH signing key: set user.signingkey in your Git configuration";
		// Git's own rule: a literal key, or the path of a key file.
		const literal = configured.startsWith("key::") ? configured.slice("key::".length) : undefined;
		if (literal !== undefined || configured.startsWith("ssh-")) {
			key = literal ?? configured;
			args = ["-Y", "sign", "-n", "git", "-f", "", "-U"];
		} else {
			const file = configured.replace(/^~(?=\/)/, homedir());
			// fork: relative to which folder? Git's, Prism's and the signer's (`/`) differ.
			if (!isAbsolute(file))
				return `your signing key ${file} is a relative path; set user.signingkey to an absolute one`;
			if (writes(file)) return `your signing key ${file} is one commands in the sandbox can change`;
			if (!existsSync(file)) return `your signing key ${file} does not exist`;
			args = ["-Y", "sign", "-n", "git", "-f", file];
		}
	}
	if (program.includes("/") && !isAbsolute(program))
		return `the signing program ${program} is a relative path; set an absolute one in your Git configuration`;
	const found = program.includes("/") ? program : findProgram(program, path);
	if (!found) return `Prism cannot find ${program}, the signing program of your Git configuration`;
	if (writes(found)) return `${found} signs your commits, and commands in the sandbox can change it`;
	return { program: found, args, key };
}

function reply(stream: Duplex, status: string, body: string): void {
	stream.end(`HTTP/1.1 ${status}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

const refuse = (stream: Duplex, message: string) =>
	reply(stream, "403 Forbidden", `Prism's sandbox refused to sign: ${message}\n`);

/** Reads the request body, at most `MAX_OBJECT`, or undefined when it is larger or the command went away. */
function readBody(stream: Duplex, length: number, rest: Buffer): Promise<Buffer | undefined> {
	return new Promise((resolve) => {
		const chunks = [rest];
		let size = rest.length;
		const done = () => {
			stream.off("data", onData);
			stream.off("close", onClose);
			stream.pause();
			resolve(Buffer.concat(chunks).subarray(0, length));
		};
		const onData = (chunk: Buffer) => {
			chunks.push(chunk);
			size += chunk.length;
			if (size >= length) done();
		};
		const onClose = () => resolve(undefined);
		if (size >= length) return resolve(rest.subarray(0, length));
		stream.on("data", onData);
		stream.on("close", onClose);
		stream.resume();
	});
}

/** Serves one signing request from the sandbox: refused unless the user turned signing on. */
export async function serveGitSign(
	stream: Duplex,
	target: string,
	headers: string[],
	rest: Buffer,
	network: CommandNetwork,
): Promise<void> {
	if (!network.gitSigning) {
		return refuse(
			stream,
			"signing with the user's key is off. Ask the user to turn on « Git signs with my key » in /settings > Permissions & sandbox.",
		);
	}
	let request: GitSignRequest;
	try {
		request = JSON.parse(Buffer.from(target, "base64url").toString("utf8")) as GitSignRequest;
	} catch {
		return refuse(stream, "malformed request");
	}
	if (
		typeof request !== "object" ||
		request === null ||
		(request.format !== "openpgp" && request.format !== "ssh") ||
		typeof request.cwd !== "string"
	) {
		return refuse(stream, "malformed request");
	}
	const length = Number(/^content-length:\s*(\d+)$/im.exec(headers.join("\n"))?.[1] ?? Number.NaN);
	if (!Number.isInteger(length) || length > MAX_OBJECT) return refuse(stream, "only Git commits and tags are signed");
	const body = await readBody(stream, length, rest);
	if (!body) return;
	const payload = body.toString("utf8");
	if (!network.sandboxWrites) return refuse(stream, "Prism does not know what this command may write");
	const plan = signingPlan(request, payload, network.sandboxWrites);
	if (typeof plan === "string") return refuse(stream, plan);
	// SSH signs a file: Prism's own, outside the sandbox.
	const scratch = mkdtempSync(join(tmpdir(), "prism-git-sign-"));
	const args = [...plan.args];
	if (request.format === "ssh") {
		if (plan.key !== undefined) {
			writeFileSync(join(scratch, "key"), `${plan.key}\n`, { mode: 0o600 });
			args[args.indexOf("")] = join(scratch, "key");
		}
		writeFileSync(join(scratch, "object"), body, { mode: 0o600 });
		args.push(join(scratch, "object"));
	}
	// No terminal: a pinentry or passphrase prompt would draw over Prism's. A graphical pinentry or the agent still work.
	const env = { ...process.env };
	delete env.GPG_TTY;
	const child = spawn(plan.program, args, { stdio: ["pipe", "pipe", "pipe"], cwd: "/", detached: true, env });
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
	child.stdin.on("error", () => {});
	child.stdin.end(request.format === "openpgp" ? body : undefined);
	stream.on("close", () => {
		if (child.exitCode === null) child.kill("SIGTERM");
	});
	const exit = await new Promise<number>((resolve) => {
		child.on("error", (error) => {
			stderr.push(Buffer.from(`Prism could not run ${plan.program}: ${error.message}\n`));
			resolve(255);
		});
		child.on("close", (code, signal) => resolve(code ?? (signal ? 255 : 0)));
	});
	const sigFile = join(scratch, "object.sig");
	const result: GitSignResult = {
		exit,
		stdout: Buffer.concat(stdout).toString("base64"),
		stderr: Buffer.concat(stderr).toString("base64"),
		signature: exit === 0 && existsSync(sigFile) ? readFileSync(sigFile).toString("base64") : undefined,
	};
	rmSync(scratch, { recursive: true, force: true });
	if (!stream.destroyed) reply(stream, "200 OK", JSON.stringify(result));
}
