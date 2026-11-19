/**
 * fork: a Node startup snapshot for the network relay. A Node built without
 * its own startup snapshot (Fedora's, linked to a shared libnode) spends about 50 ms per command building its
 * runtime; the relay started from this snapshot does not. A Node that has its own snapshot (nodejs.org builds)
 * gains nothing from it, so it is made only for the first kind.
 *
 * The snapshot holds a loader, not the relay: the relay and the modules it imports load after it starts, as
 * they do without it. The command line passes it to Node as /proc/self/fd/6, open from a file in the agent
 * dir, which the sandbox does not show; the loader closes the descriptor before the relay runs its command.
 * It is built with an empty environment, so it holds nothing of Prism's. Without a snapshot the relay starts as
 * before, and so it does when the sandbox's check at start fails with one (`startSandbox`).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** Runs in Node building the snapshot; at each start, loads the file Node was given (the relay) and closes fd 6. */
const LOADER = `"use strict";
require("node:v8").startupSnapshot.setDeserializeMainFunction(() => {
	try {
		require("node:fs").closeSync(6);
	} catch {}
	const file = process.argv[1];
	require("node:module").createRequire(file)(file);
});
`;

/** Whether this runtime is a Node built without its own startup snapshot, the only kind measured to gain from one. */
export function relaySnapshotGains(): boolean {
	const variables: Record<string, unknown> = process.config.variables;
	return !process.versions.bun && variables.node_use_node_snapshot === false;
}

/** Where the relay's snapshot for this Node is, made if needed; undefined when there is none to use. */
export function relaySnapshot(agentDir: string): string | undefined {
	if (process.env.PRISM_SANDBOX_RELAY_SNAPSHOT === "0" || !relaySnapshotGains()) return undefined;
	const folder = join(agentDir, "sandbox");
	const binary = statSync(process.execPath);
	const key = createHash("sha256")
		.update([process.execPath, process.version, binary.size, binary.mtimeMs, LOADER].join("\0"))
		.digest("hex")
		.slice(0, 16);
	const blob = join(folder, `relay-${key}.blob`);
	if (existsSync(blob)) return blob;
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	// Those of other Nodes; another start of this one may have just made this one.
	for (const name of readdirSync(folder)) {
		if (/^relay-[0-9a-f]{16}\.blob$/.test(name) && name !== basename(blob))
			rmSync(join(folder, name), { force: true });
	}
	const temporary = `${blob}.${process.pid}`;
	const loader = `${temporary}.cjs`;
	try {
		writeFileSync(loader, LOADER, { mode: 0o600 });
		const built = spawnSync(process.execPath, ["--snapshot-blob", temporary, "--build-snapshot", loader], {
			env: {},
			stdio: "ignore",
			timeout: 30_000,
		});
		if (built.status !== 0) return undefined;
		renameSync(temporary, blob);
		return blob;
	} finally {
		for (const path of [temporary, loader]) rmSync(path, { force: true });
	}
}
