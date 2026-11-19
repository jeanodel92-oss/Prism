/**
 * fork: one network namespace per session, which its sandboxed commands share.
 * A server a command or a background task starts (`npm run dev`) is then reachable at `localhost` from the next
 * command, as without the sandbox; before, each command had a loopback of its own and saw nothing of the others.
 *
 * The namespace is made once, by a bubblewrap that only holds it while Prism opens it, and kept by those open files:
 * a command joins it through `nsenter`, by Prism's own descriptors (`/proc/<pid>/fd/<n>`), so a reused process id
 * can never lead it into another namespace. Without `nsenter`, or when the namespace cannot be made, each command
 * has its own loopback, as before.
 *
 * The commands of a session share a loopback, not their permissions: each relay serves only the processes of its
 * own command (`relay.ts`).
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readlinkSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { hostProgram } from "../host-program.ts";

interface SessionNet {
	user: number;
	net: number;
}

/** By session, as its private /tmp names it; null when it could not be made. */
const nets = new Map<string, SessionNet | null>();
const pending = new Map<string, Promise<void>>();

let nsenter: string | null | undefined;

function findNsenter(): string | null {
	if (nsenter === undefined) {
		// fork: run at each session, never from where the sandbox writes.
		nsenter = hostProgram("nsenter") ?? null;
	}
	return nsenter;
}

/** A new user and network namespace, held open by Prism; undefined when it cannot be made. */
async function makeNet(bwrap: string): Promise<SessionNet | undefined> {
	const holder = spawn(
		bwrap,
		["--unshare-user", "--unshare-net", "--die-with-parent", "--ro-bind", "/", "/", "--", "sleep", "30"],
		{ stdio: "ignore" },
	);
	// A bubblewrap that cannot start (missing, refused) leaves commands their own loopback.
	holder.on("error", () => {});
	const pid = holder.pid;
	if (pid === undefined) return undefined;
	try {
		const own = readlinkSync("/proc/self/ns/net");
		for (let waited = 0; waited < 5000; waited += 10) {
			let children: string[] = [];
			try {
				children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
			} catch {
				return undefined;
			}
			for (const child of children) {
				let user: number | undefined;
				try {
					if (readlinkSync(`/proc/${child}/ns/net`) === own) continue;
					// Only once bubblewrap is done (its uid map written, `sleep` running): a namespace opened earlier
					// may stay without a map, where bubblewrap cannot make the commands' own namespaces.
					if (readFileSync(`/proc/${child}/comm`, "utf8").trim() !== "sleep") continue;
					if (!readFileSync(`/proc/${child}/uid_map`, "utf8").trim()) continue;
					user = openSync(`/proc/${child}/ns/user`, "r");
					return { user, net: openSync(`/proc/${child}/ns/net`, "r") };
				} catch {
					if (user !== undefined) closeSync(user);
				}
			}
			await pause(10);
		}
		return undefined;
	} finally {
		holder.kill("SIGKILL");
	}
}

/**
 * The words that put a command in the session's network namespace, before bubblewrap; empty when the session has
 * none, and the command then gets a loopback of its own (bubblewrap's `--unshare-all` without `--share-net`).
 */
export function sessionNetPrefix(session: string): string[] {
	const program = findNsenter();
	if (!program) return [];
	const net = nets.get(session);
	const fd = (n: number) => `/proc/${process.pid}/fd/${n}`;
	const words = (made: SessionNet) => [
		program,
		`--user=${fd(made.user)}`,
		`--net=${fd(made.net)}`,
		"--preserve-credentials",
		"--",
	];
	return net ? words(net) : [];
}

/** Initialize before the synchronous shell-config callback; concurrent commands share one holder. */
export async function prepareSessionNet(session: string, bwrap: string): Promise<void> {
	if (nets.has(session) || !findNsenter()) return;
	const known = pending.get(session);
	if (known) return known;
	let making!: Promise<void>;
	making = (async () => {
		let net = (await makeNet(bwrap)) ?? null;
		// A session closed while its namespace was starting must not retain descriptors.
		if (pending.get(session) !== making) {
			if (net) {
				closeSync(net.user);
				closeSync(net.net);
			}
			return;
		}
		nets.set(session, net);
		// Joined once here, so that a system refusing it leaves commands their own loopback instead of failing them.
		const words = sessionNetPrefix(session);
		if (net && spawnSync(words[0]!, [...words.slice(1), "true"], { stdio: "ignore" }).status !== 0) {
			closeSync(net.user);
			closeSync(net.net);
			net = null;
		}
		nets.set(session, net);
	})();
	pending.set(session, making);
	try {
		await making;
	} finally {
		if (pending.get(session) === making) pending.delete(session);
	}
}

/**
 * fork: why the session's commands do not share `localhost`, said to the user
 * at the start; undefined when they do. Makes the namespace now rather than at the first command.
 */
export async function sessionNetReport(
	session: string,
	bwrap: string,
	program = findNsenter(),
): Promise<string | undefined> {
	const loss =
		"so the commands of this session do not share localhost: a server a command or a background task starts is not reachable from the next command.";
	if (!program) return `Prism: nsenter (util-linux) was not found, ${loss} Install nsenter to share it.`;
	await prepareSessionNet(session, bwrap);
	if (sessionNetPrefix(session).length > 0) return undefined;
	return `Prism: this system refused the session's network namespace, ${loss}`;
}

/** Forgets the session's namespace; its commands still running keep it. */
export function closeSessionNet(session: string): void {
	pending.delete(session);
	const net = nets.get(session);
	nets.delete(session);
	if (!net) return;
	closeSync(net.user);
	closeSync(net.net);
}
