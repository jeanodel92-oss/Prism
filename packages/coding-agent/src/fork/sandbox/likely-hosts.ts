/**
 * fork: the hosts a command will probably contact, shown in its permission
 * question so one answer covers the command and them. A suggestion only: it grants nothing by itself, a
 * private registry or a mirror is not in it, and every other host is asked about as usual. Kept small on
 * purpose: a few package managers, and the host of a Git https URL.
 * fork: also a port of this machine written in the command (`localhost:3000`, `127.0.0.1:5432`,
 * `[::1]:8080`): most programs reach it without the proxy, so only this question can open it for the run.
 * fork: Git over SSH to the host of a Git ssh URL (`ssh://git@host/…`, `git@host:…`), as
 * `ssh://<host>`. The scp-like form counts only with its user, so a refspec such as `main:main` is no host.
 */

import { isMachineAddress, isMachineName, isSandboxLoopback } from "./dns-guard.ts";
import { gitSshName } from "./git-ssh.ts";

interface Ecosystem {
	/** The program and its subcommands that download, e.g. `npm` with `install`. */
	program: RegExp;
	subcommands: RegExp;
	hosts: string[];
}

const ECOSYSTEMS: Ecosystem[] = [
	{ program: /^(npm|pnpm|yarn)$/, subcommands: /^(install|i|ci|add|update|up)$/, hosts: ["registry.npmjs.org"] },
	{
		program: /^(pip|pip3|python3? -m pip|uv pip)$/,
		subcommands: /^(install|download)$/,
		hosts: ["pypi.org", "files.pythonhosted.org"],
	},
	{
		program: /^cargo$/,
		subcommands: /^(build|test|run|check|fetch|add|update|install)$/,
		hosts: ["index.crates.io", "static.crates.io"],
	},
	{
		program: /^go$/,
		subcommands: /^(build|test|run|get|install|mod)$/,
		hosts: ["proxy.golang.org", "sum.golang.org"],
	},
];

const GIT_NETWORK = /^(clone|fetch|pull|push|ls-remote|submodule)$/;

/** A `host:port` word part; the host counts when it is this machine, as the proxy decides. */
const HOST_PORT = /(?:^|[\s/@='"])(\[[0-9a-f:.]+\]|[^\s/@='":[\]]+):(\d{1,5})(?!\d)/gi;

/** The words of one segment, without leading `VAR=value` assignments. */
function words(segment: string): string[] {
	const all = segment.trim().split(/\s+/).filter(Boolean);
	let start = 0;
	while (start < all.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(all[start]!)) start++;
	return all.slice(start);
}

/**
 * The hosts a command will probably contact, from its segments (split as the permission rules split it),
 * in order and without duplicates; empty when none is known.
 */
export function likelyHosts(segments: readonly string[]): string[] {
	const hosts = new Set<string>();
	for (const segment of segments) {
		for (const [, host = "", port] of segment.matchAll(HOST_PORT)) {
			// fork (SEC-07): `localhost` and 127.x are the sandbox's own, which needs no permission.
			const machine =
				!isSandboxLoopback(host) && (isMachineName(host) || isMachineAddress(host.replace(/^\[|\]$/g, "")));
			if (machine && Number(port) > 0 && Number(port) < 65536) hosts.add(`localhost:${Number(port)}`);
		}
		const [first, ...rest] = words(segment);
		if (!first) continue;
		if (first === "git" && rest.some((word) => GIT_NETWORK.test(word))) {
			for (const word of rest) {
				const url = /^https:\/\/(?:[^@/]+@)?([^/:]+)/.exec(word);
				if (url) hosts.add(url[1]!.toLowerCase());
				const ssh =
					/^(?:ssh|git\+ssh|ssh\+git):\/\/(?:[^@/]+@)?([A-Za-z0-9_][A-Za-z0-9._-]*)/i.exec(word) ??
					/^[A-Za-z0-9._][A-Za-z0-9._-]*@([A-Za-z0-9_][A-Za-z0-9._-]*):(?!\/\/)/.exec(word);
				if (ssh) hosts.add(gitSshName(ssh[1]!));
			}
			continue;
		}
		for (const ecosystem of ECOSYSTEMS) {
			// `python -m pip install` and `uv pip install`: the program is two or three words.
			for (let length = 1; length <= 3 && length <= rest.length; length++) {
				const program = [first, ...rest.slice(0, length - 1)].join(" ");
				if (ecosystem.program.test(program) && ecosystem.subcommands.test(rest[length - 1] ?? "")) {
					for (const host of ecosystem.hosts) hosts.add(host);
				}
			}
		}
	}
	return [...hosts];
}
