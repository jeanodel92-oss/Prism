/**
 * fork: Git's `gpg.program` and `gpg.ssh.program` inside the sandbox, through a wrapper the relay
 * writes. Git's two signing commands go to Prism, which signs outside the sandbox (`git-sign.ts`); everything
 * else (verifying a signature) runs the usual program here, as it would without Prism.
 * Usage: node git-sign-client.ts <proxy port> <arguments from Git>
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { GIT_SIGN_METHOD, type GitSignRequest, type GitSignResult } from "./git-sign.ts";

const fail = (message: string): never => {
	process.stderr.write(`prism sandbox: ${message}\n`);
	process.exit(1);
};

const [proxyPort = "", ...args] = process.argv.slice(2);
// Git's commands (gpg-interface.c): `--status-fd=2 -bsau <key>`, and `-Y sign -n git -f <key> [-U] <file>`.
const openpgp = args.length === 3 && args[0] === "--status-fd=2" && args[1] === "-bsau";
const ssh = args[0] === "-Y" && args[1] === "sign";
if (!openpgp && !ssh) {
	const program = args[0] === "-Y" ? "ssh-keygen" : "gpg";
	const result = spawnSync(program, args, { stdio: "inherit" });
	if (result.error) fail(`cannot run ${program}: ${result.error.message}`);
	process.exit(result.status ?? 1);
}
if (ssh && (args[2] !== "-n" || args[3] !== "git")) fail("only Git's own signatures are made from the sandbox.");
const file = args[args.length - 1]!;
const payload = openpgp ? readFileSync(0) : readFileSync(file);
const request: GitSignRequest = { format: openpgp ? "openpgp" : "ssh", cwd: process.cwd() };

const socket = connect({ host: "127.0.0.1", port: Number(proxyPort), allowHalfOpen: true });
socket.on("error", (error) => fail(`cannot reach Prism to sign: ${error.message}`));
socket.write(
	`${GIT_SIGN_METHOD} ${Buffer.from(JSON.stringify(request)).toString("base64url")} HTTP/1.1\r\nContent-Length: ${payload.length}\r\n\r\n`,
);
socket.write(payload);
const chunks: Buffer[] = [];
socket.on("data", (chunk: Buffer) => chunks.push(chunk));
socket.on("end", () => {
	const response = Buffer.concat(chunks);
	const end = response.indexOf("\r\n\r\n");
	const head = response.subarray(0, Math.max(end, 0)).toString("latin1");
	const body = response.subarray(end + 4).toString("utf8");
	if (end < 0) fail("Prism closed the connection before signing.");
	if (!head.startsWith("HTTP/1.1 200 ")) {
		process.stderr.write(body);
		process.exit(1);
	}
	const result = JSON.parse(body) as GitSignResult;
	if (ssh && result.signature) writeFileSync(`${file}.sig`, Buffer.from(result.signature, "base64"));
	process.stdout.write(Buffer.from(result.stdout, "base64"), () =>
		process.stderr.write(Buffer.from(result.stderr, "base64"), () => process.exit(result.exit)),
	);
});
