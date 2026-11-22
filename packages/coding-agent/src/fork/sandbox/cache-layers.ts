/**
 * fork: the package caches commands write (`~/.npm`,
 * `~/.cargo/registry`, `~/go/pkg`…) are the user's own, shared by every project, and tools run what is extracted
 * there without checking it again (`npx` runs `~/.npm/_npx` as it finds it). A command that rewrote them in the
 * sandbox had its code run outside it at the user's next `npx`. Each command now sees the real caches through an
 * overlay: it reads them, and what it writes goes to a layer of its own, removed when the command ends. Nothing a
 * command writes there reaches the real caches.
 *
 * Overlays need bubblewrap 0.11 and a kernel that allows them in a user namespace. Without them, each cache is
 * replaced by a private one for the project, empty at first: downloads are made again, but never shared with the
 * user's tools.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** How a cache is shown to one command: an overlay over the real cache, or a private folder bound in its place. */
export type CacheLayer = { path: string; upper: string; work: string } | { path: string; source: string };

const supported = new Map<string, boolean>();
const live = new Set<string>();
let exitHooked = false;

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

/** Gives the maintainer access to every folder under `dir`, symbolic links left alone. */
function openFolders(dir: string): void {
	chmodSync(dir, 0o700);
	for (const entry of readdirSync(dir, { withFileTypes: true }))
		if (entry.isDirectory()) openFolders(join(dir, entry.name));
}

const removeLayer = (dir: string) => {
	live.delete(dir);
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// overlayfs makes each layer's work/work folder mode 000 and can leave entries in it (after a command deleted a
		// folder of the real cache): it can only be emptied once opened again.
		try {
			openFolders(dir);
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
};

/** Removes the layers of Prism processes that ended without removing theirs (killed, crashed). */
function removeOrphanLayers(root: string): void {
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return;
	}
	for (const name of names) {
		const pid = Number(/^(\d+)-/.exec(name)?.[1]);
		if (!pid || pid === process.pid || isAlive(pid)) continue;
		const dir = join(root, name);
		const stat = lstatSync(dir, { throwIfNoEntry: false });
		if (stat?.isDirectory() && stat.uid === process.getuid?.()) removeLayer(dir);
	}
}

/**
 * Whether `bwrap` can mount an overlay over each of `caches` here: tried once per process for each list, by
 * mounting them all in a throwaway sandbox that runs `true`.
 */
export function overlaysWork(bwrap: string, caches: readonly string[], root: string): boolean {
	const key = [bwrap, ...caches].join("\0");
	const known = supported.get(key);
	if (known !== undefined) return known;
	let works = false;
	let dir: string | undefined;
	try {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		dir = mkdtempSync(join(root, `${process.pid}-probe-`));
		const args = ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev"];
		for (const [index, path] of caches.entries()) {
			const upper = join(dir, String(index), "upper");
			const work = join(dir, String(index), "work");
			mkdirSync(upper, { recursive: true });
			mkdirSync(work);
			args.push("--overlay-src", path, "--overlay", upper, work, path);
		}
		const result = spawnSync(bwrap, [...args, "true"], { stdio: "ignore", timeout: 10_000 });
		works = result.status === 0;
	} catch {
		works = false;
	} finally {
		if (dir) removeLayer(dir);
	}
	supported.set(key, works);
	return works;
}

/**
 * One command's view of `caches`. With overlays, a new layer per cache under `root`; `release` removes them, and
 * Prism's exit removes those still there. Without, the project's private caches under `fallback`, kept.
 */
export function cacheLayers(
	caches: readonly string[],
	options: { overlays: boolean; root: string; fallback: string; project: string },
): { layers: CacheLayer[]; folders: string[]; release: () => void } {
	if (caches.length === 0) return { layers: [], folders: [], release: () => {} };
	if (!options.overlays) {
		const project = createHash("sha256").update(options.project).digest("hex").slice(0, 16);
		const layers = caches.map((path) => {
			const name = createHash("sha256").update(path).digest("hex").slice(0, 16);
			const source = join(options.fallback, project, name);
			mkdirSync(source, { recursive: true, mode: 0o700 });
			return { path, source };
		});
		return { layers, folders: layers.map(({ source }) => source), release: () => {} };
	}
	if (!exitHooked) {
		exitHooked = true;
		process.once("exit", () => {
			for (const dir of [...live]) removeLayer(dir);
		});
	}
	mkdirSync(options.root, { recursive: true, mode: 0o700 });
	if (live.size === 0) removeOrphanLayers(options.root);
	const dir = mkdtempSync(join(options.root, `${process.pid}-`));
	live.add(dir);
	const layers = caches.map((path, index) => {
		const upper = join(dir, String(index), "upper");
		const work = join(dir, String(index), "work");
		mkdirSync(upper, { recursive: true });
		mkdirSync(work);
		return { path, upper, work };
	});
	return { layers, folders: [dir], release: () => removeLayer(dir) };
}
