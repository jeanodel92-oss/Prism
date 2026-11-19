/**
 * fork: Git's SSH command inside the sandbox (`GIT_SSH_COMMAND`, set by the relay, with
 * `GIT_SSH_VARIANT=ssh`). It passes Git's request to Prism through the relay's proxy, then carries ssh's input
 * and output, so Git sees an ordinary ssh. Usage: node git-ssh-client.ts <proxy port> <ssh arguments from Git>
 */

import { connect } from "node:net";
import { FRAME_EXIT, FRAME_STDERR, FRAME_STDOUT, GIT_SSH_METHOD, type GitSshRequest } from "./git-ssh.ts";

const fail = (message: string): never => {
	process.stderr.write(`prism sandbox: ${message}\n`);
	process.exit(255);
};

/** Reads the arguments Git gives an OpenSSH-like command: `[-o SendEnv=GIT_PROTOCOL] [-p port] [-4|-6] host command`. */
function parse(args: string[]): GitSshRequest {
	let port: number | undefined;
	let family: 4 | 6 | undefined;
	let index = 0;
	for (; index < args.length && args[index]!.startsWith("-"); index++) {
		const option = args[index]!;
		if (option === "-p") port = Number(args[++index]);
		else if (option === "-4" || option === "-6") family = option === "-4" ? 4 : 6;
		else if (option === "-o" && args[index + 1] === "SendEnv=GIT_PROTOCOL") index++;
		else if (option === "--") {
			index++;
			break;
		} else fail(`only Git's own use of ssh works in the sandbox, through Prism (option ${option} is not passed).`);
	}
	const [destination, ...command] = args.slice(index);
	if (!destination || command.length === 0) fail("ssh in the sandbox runs Git's commands only, through Prism.");
	return { destination: destination!, port, family, command: command.join(" "), protocol: process.env.GIT_PROTOCOL };
}

const [proxyPort = "", ...args] = process.argv.slice(2);
const request = parse(args);
const socket = connect({ host: "127.0.0.1", port: Number(proxyPort), allowHalfOpen: true });
socket.on("error", (error) => fail(`cannot reach Prism for Git over SSH: ${error.message}`));
socket.write(`${GIT_SSH_METHOD} ${Buffer.from(JSON.stringify(request)).toString("base64url")} HTTP/1.1\r\n\r\n`);

let buffered: Buffer = Buffer.alloc(0);
let replied = false;
let refused = false;
let exitCode = 255;
socket.on("data", (chunk: Buffer) => {
	buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
	if (!replied) {
		const end = buffered.indexOf("\r\n\r\n");
		if (end < 0) return;
		const head = buffered.subarray(0, end).toString("latin1");
		if (!head.startsWith("HTTP/1.1 200 ")) {
			// Refused: Prism's reason is the body.
			refused = true;
			socket.removeAllListeners("data");
			const body: Buffer[] = [buffered.subarray(end + 4)];
			socket.on("data", (more: Buffer) => body.push(more));
			socket.on("end", () => {
				process.stderr.write(Buffer.concat(body));
				process.exit(255);
			});
			return;
		}
		replied = true;
		buffered = buffered.subarray(end + 4);
		process.stdin.pipe(socket);
	}
	while (buffered.length >= 5) {
		const type = buffered.readUInt8(0);
		const length = buffered.readUInt32BE(1);
		if (buffered.length < 5 + length) return;
		const payload = buffered.subarray(5, 5 + length);
		buffered = buffered.subarray(5 + length);
		const output = type === FRAME_STDOUT ? process.stdout : type === FRAME_STDERR ? process.stderr : undefined;
		// Git reads slower than ssh sends: wait for it rather than buffer.
		if (output && !output.write(payload)) {
			socket.pause();
			output.once("drain", () => socket.resume());
		}
		if (type === FRAME_EXIT) exitCode = payload.readUInt8(0);
	}
});
socket.on("end", () => {
	if (replied) process.stdout.write("", () => process.stderr.write("", () => process.exit(exitCode)));
	else if (!refused) fail("Prism closed the connection for Git over SSH.");
});
