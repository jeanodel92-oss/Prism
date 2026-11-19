/**
 * fork: the packs a sandboxed command wrote into its private Git folder (a fetch, a
 * push received), checked by Git itself before they are published (`git-validate.ts`). Each pack goes through
 * `git index-pack --strict` in a sandbox of its own: no network, none of the user's files but the system's
 * programs, the repository's objects read-only. Git rebuilds the pack's index there and checks every object and
 * that each object it names exists, in the pack or in the repository; the index the command wrote is never used.
 *
 * The host reads nothing of a pack but the headers of its entries, to know their types. Packs are checked as the
 * bytes that will be published, so a process still running cannot change them in between.
 */

import { spawn } from "node:child_process";
import {
	accessSync,
	closeSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { open, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { type GitFile, gitFileStream, writeGitFile } from "./git-files.ts";
import type { GitChange } from "./git-publish.ts";
import { gitObjectStore, type HashFormat, type ObjectType, type Refusal } from "./git-validate.ts";

/** A pack's size limit, also enforced by Git while streaming its input. */
export const MAX_PACK = 512 * 1024 * 1024;
const TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT = 64 * 1024;

export interface PackSandbox {
	bwrap: string;
	/** The seccomp filter's file (`SandboxRuntime.seccomp`). */
	seccomp: string;
}

export interface VerifiedPack {
	objects: Map<string, ObjectType>;
	/** The index Git rebuilt, published in place of the command's. */
	idx: Buffer;
}

export interface PackInput {
	sandbox: PackSandbox;
	/** The new packs, by path relative to the Git folder (`objects/pack/pack-<hash>.pack`), as they will be published. */
	packs: Array<{ path: string; bytes: Buffer | GitFile }>;
	/** The real repository's object folders, which the pack's objects may name. */
	stores: string[];
	/** The private Git folder's object folder, whose loose objects (new ones) the pack's objects may name too. */
	loose?: string;
	format: HashFormat;
	/** An empty folder of the caller's, removed by it afterwards. */
	scratch: string;
}

/** The `git` on PATH, by its real path, if it lives under /usr: the only programs the pack sandbox shows. */
function systemGit(path = process.env.PATH ?? ""): string | undefined {
	for (const dir of path.split(delimiter)) {
		if (!dir) continue;
		try {
			const candidate = join(dir, "git");
			accessSync(candidate, constants.X_OK);
			if (!statSync(candidate).isFile()) continue;
			const real = realpathSync(candidate);
			return real.startsWith("/usr/") ? real : undefined;
		} catch {}
	}
	return undefined;
}

/** The system's programs and libraries, read-only, with the links of a merged /usr kept as links. */
function systemArgs(): string[] {
	const args = ["--ro-bind", "/usr", "/usr"];
	for (const top of ["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"]) {
		const entry = lstatSync(top, { throwIfNoEntry: false });
		if (entry?.isSymbolicLink()) args.push("--symlink", readlinkSync(top), top);
		else if (entry?.isDirectory()) args.push("--ro-bind", top, top);
	}
	if (existsSync("/etc/ld.so.cache")) args.push("--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache");
	return args;
}

/** The entries of a version 2 pack index, by name. */
function indexNames(idx: Buffer, format: HashFormat): string[] | undefined {
	const hashBytes = format === "sha256" ? 32 : 20;
	if (idx.length < 8 + 1024 || idx.readUInt32BE(0) !== 0xff744f63 || idx.readUInt32BE(4) !== 2) return undefined;
	const count = idx.readUInt32BE(8 + 1020);
	if (idx.length < 8 + 1024 + count * (hashBytes + 8)) return undefined;
	const names: string[] = [];
	for (let i = 0; i < count; i++) {
		const at = 8 + 1024 + i * hashBytes;
		names.push(idx.toString("hex", at, at + hashBytes));
	}
	return names;
}

/** Reads a file Git wrote in the scratch folder: a regular file, never through a link. */
async function readOwn(path: string, limit: number): Promise<Buffer | undefined> {
	let fd: Awaited<ReturnType<typeof open>> | undefined;
	try {
		fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = await fd.stat();
		if (!stat.isFile() || stat.size > limit) return undefined;
		return await fd.readFile();
	} catch {
		return undefined;
	} finally {
		await fd?.close();
	}
}

interface Run {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: string;
}

function run(program: string, args: string[], stdin: Buffer | GitFile, seccomp: string): Promise<Run> {
	const filter = openSync(seccomp, constants.O_RDONLY);
	return new Promise((resolve) => {
		const child = spawn(program, args, {
			env: {
				PATH: "/usr/bin:/bin",
				HOME: "/work",
				LC_ALL: "C",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
			},
			stdio: ["pipe", "pipe", "pipe", filter],
			timeout: TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		closeSync(filter);
		let stdout = "";
		let stderr = "";
		let error: string | undefined;
		const collect = (into: "stdout" | "stderr") => (chunk: Buffer) => {
			if (stdout.length + stderr.length > MAX_OUTPUT) return;
			if (into === "stdout") stdout += chunk.toString("utf8");
			else stderr += chunk.toString("utf8");
		};
		child.stdout!.on("data", collect("stdout"));
		child.stderr!.on("data", collect("stderr"));
		child.on("error", (failure) => {
			error = failure.message;
		});
		// Git may stop reading early (a bad pack); the write error that follows says nothing more.
		child.stdin!.on("error", () => {});
		const feeding = Buffer.isBuffer(stdin)
			? new Promise<void>((done) => {
					child.stdin!.end(stdin, done);
					child.stdin!.on("error", () => done());
				})
			: pipeline(gitFileStream(stdin), child.stdin!).catch((failure: Error) => {
					if (
						(failure as NodeJS.ErrnoException).code !== "EPIPE" &&
						(failure as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE"
					)
						error ??= failure.message;
				});
		child.on(
			"close",
			(status, signal) =>
				void feeding.then(() =>
					resolve({ status, stdout, stderr, error: error ?? (signal ? `ended by ${signal}` : undefined) }),
				),
		);
	});
}

/** The command's loose objects and verified packs, as a bare repository at `source`; returns their names. */
async function writeSource(
	source: string,
	input: {
		objects: GitChange[];
		packs: Array<{ path: string; bytes: Buffer | GitFile; verified: VerifiedPack }>;
		format: HashFormat;
	},
): Promise<Set<string>> {
	mkdirSync(join(source, "objects", "pack"), { recursive: true, mode: 0o700 });
	mkdirSync(join(source, "refs"));
	writeFileSync(join(source, "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(
		join(source, "config"),
		input.format === "sha256"
			? "[core]\nrepositoryformatversion = 1\nbare = true\n[extensions]\nobjectformat = sha256\n"
			: "[core]\nrepositoryformatversion = 0\nbare = true\n",
	);
	const names = new Set<string>();
	for (const { path, after } of input.objects) {
		mkdirSync(join(source, path, ".."), { recursive: true });
		await writeGitFile(join(source, path), after!);
		names.add(path.slice(8).replace("/", ""));
	}
	for (const { path, bytes, verified } of input.packs) {
		await writeGitFile(join(source, path), bytes);
		await writeFile(join(source, path.replace(/\.pack$/, ".idx")), verified.idx);
		for (const name of verified.objects.keys()) names.add(name);
	}
	return names;
}

/** The real object stores, read-only under `/stores/<n>`, and those paths for an alternates file. */
function storeMounts(stores: string[]): { mounts: string[]; alternates: string[] } {
	const mounts: string[] = [];
	const alternates: string[] = [];
	stores.forEach((store, n) => {
		mounts.push("--ro-bind", store, `/stores/${n}`);
		alternates.push(`/stores/${n}`);
	});
	return { mounts, alternates };
}

/** The sandbox around a confined Git: the system's programs, `work` as `/work`, nothing else of the user's. */
const confinedArgs = (work: string, mounts: string[]) => [
	"--unshare-all",
	"--die-with-parent",
	"--new-session",
	...systemArgs(),
	"--proc",
	"/proc",
	"--dev",
	"/dev",
	"--tmpfs",
	"/tmp",
	"--bind",
	work,
	"/work",
	...mounts,
	"--chdir",
	"/work",
	"--seccomp",
	"3",
	"--",
];

/**
 * fork: the entries of `commits` that hold a submodule (mode
 * 160000) at one of `paths`, as `path (commit <oid>)`; or why Git could not tell. A command that made a repository
 * whose hooks or configuration run programs, committed it as a submodule and then removed it from the index left a
 * commit that a checkout outside Prism turns back into an index that lists it, and `git status` then runs them.
 * Read by a confined Git, from the command's objects and the repository's, as {@link verifyLooseObjects} does.
 * With `added` (AS-026), only the submodules a commit adds: absent from its first parent, or there as another type.
 */
export async function submodulesInCommits(input: {
	sandbox: PackSandbox;
	objects: GitChange[];
	packs: Array<{ path: string; bytes: Buffer | GitFile; verified: VerifiedPack }>;
	stores: string[];
	format: HashFormat;
	scratch: string;
	commits: string[];
	paths: string[];
	added?: boolean;
}): Promise<string[] | string> {
	if (input.commits.length === 0 || input.paths.length === 0) return [];
	if (!systemGit()) return "Git installed under /usr is needed to read the command's commits";
	const work = mkdtempSync(join(input.scratch, "gitlinks-"));
	try {
		await writeSource(join(work, "source"), input);
		const { mounts, alternates } = storeMounts(input.stores);
		mkdirSync(join(work, "source", "objects", "info"));
		writeFileSync(join(work, "source", "objects", "info", "alternates"), `${alternates.join("\n")}\n`);
		writeFileSync(join(work, "commits"), `${input.commits.join("\n")}\n`);
		const result = await run(
			input.sandbox.bwrap,
			[
				...confinedArgs(work, mounts),
				"/bin/sh",
				"-c",
				input.added
					? 'while read -r commit; do out=$(git --literal-pathspecs --git-dir=/work/source diff-tree -r --root --no-commit-id --diff-merges=first-parent "$commit" -- "$@") || exit 1; [ -z "$out" ] || printf "commit %s\\n%s\\n" "$commit" "$out"; done </work/commits'
					: 'while read -r commit; do out=$(git --literal-pathspecs --git-dir=/work/source ls-tree "$commit" -- "$@") || exit 1; [ -z "$out" ] || printf "commit %s\\n%s\\n" "$commit" "$out"; done </work/commits',
				"sh",
				...input.paths,
			],
			Buffer.alloc(0),
			input.sandbox.seccomp,
		);
		if (result.status !== 0 || result.error)
			return (result.error ?? result.stderr.trim()).slice(0, 1000) || `exit ${result.status}`;
		const found: string[] = [];
		let commit = "";
		for (const line of result.stdout.split("\n")) {
			if (line.startsWith("commit ")) commit = line.slice(7);
			const entry = input.added
				? /^:[0-7]{6} 160000 [0-9a-f]+ [0-9a-f]+ [AT]\t(.+)$/.exec(line)
				: /^160000 commit [0-9a-f]+\t(.+)$/.exec(line);
			if (entry) found.push(`${entry[1]} (commit ${commit})`);
		}
		return found;
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

/** Check immutable loose bytes with the same fsck as fetched packs, including cross-object .gitmodules checks. */
export async function verifyLooseObjects(input: {
	sandbox: PackSandbox;
	objects: GitChange[];
	packs: Array<{ path: string; bytes: Buffer | GitFile; verified: VerifiedPack }>;
	stores: string[];
	format: HashFormat;
	scratch: string;
}): Promise<Refusal[]> {
	if (input.objects.length === 0) return [];
	const refuse = (reason: string) => input.objects.map(({ path }) => ({ path, reason }));
	if (!systemGit()) return refuse("is a loose object, which the sandbox checks only with a Git installed under /usr");
	const work = mkdtempSync(join(input.scratch, "loose-fsck-"));
	try {
		const names = await writeSource(join(work, "source"), input);
		writeFileSync(join(work, "names"), `${[...names].join("\n")}\n`);
		const { mounts, alternates } = storeMounts(input.stores);
		// Keep verified pack deltas: expanding them could exceed the publication budget.
		const result = await run(
			input.sandbox.bwrap,
			[
				"--unshare-all",
				"--die-with-parent",
				"--new-session",
				...systemArgs(),
				"--proc",
				"/proc",
				"--dev",
				"/dev",
				"--tmpfs",
				"/tmp",
				"--bind",
				work,
				"/work",
				...mounts,
				"--chdir",
				"/work",
				"--seccomp",
				"3",
				"--",
				"/bin/sh",
				"-c",
				'format=$1; shift; git init -q --bare --template= --object-format="$format" /work/repo && printf "%s\\n" "$@" >/work/repo/objects/info/alternates && git --git-dir=/work/source pack-objects --stdout --window=0 </work/names >/work/loose.pack && exec git --git-dir=/work/repo index-pack --stdin --strict --max-input-size=' +
					MAX_PACK +
					" </work/loose.pack",
				"sh",
				input.format,
				...alternates,
			],
			Buffer.alloc(0),
			input.sandbox.seccomp,
		);
		if (result.status === 0 && /^pack\t[0-9a-f]+\n$/.test(result.stdout)) return [];
		const why = (result.error ?? result.stderr.trim()).slice(0, 1000);
		return refuse(`is a loose object Git refused: ${why || `exit ${result.status}`}`);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

/** The packs Git accepted, with their objects; a refusal for each other one, which then nothing may publish. */
export async function verifyPacks(input: PackInput): Promise<{ packs: Map<string, VerifiedPack>; refused: Refusal[] }> {
	const packs = new Map<string, VerifiedPack>();
	const refused: Refusal[] = [];
	if (input.packs.length === 0) return { packs, refused };
	const git = systemGit();
	if (!git) {
		for (const { path } of input.packs)
			refused.push({ path, reason: "is a pack, which the sandbox checks only with a Git installed under /usr" });
		return { packs, refused };
	}
	const work = join(input.scratch, "work");
	mkdirSync(work, { recursive: true, mode: 0o700 });
	const mounts: string[] = [];
	const alternates: string[] = [];
	input.stores.forEach((store, n) => {
		mounts.push("--ro-bind", store, `/stores/${n}`);
		alternates.push(`/stores/${n}`);
	});
	if (input.loose) {
		// Only its loose objects' folders: its packs and alternates are what nobody has checked yet.
		for (const entry of readdirSync(input.loose, { withFileTypes: true })) {
			if (/^[0-9a-f]{2}$/.test(entry.name) && entry.isDirectory())
				mounts.push("--ro-bind", join(input.loose, entry.name), `/loose/${entry.name}`);
		}
		alternates.push("/loose");
	}
	// One repository for all the packs: a pack may name objects of one checked before it.
	const script =
		'format=$1; shift; [ -d /work/repo ] || { git init -q --bare --object-format="$format" /work/repo && printf "%s\\n" "$@" >/work/repo/objects/info/alternates; } && exec git --git-dir=/work/repo index-pack --stdin --strict --max-input-size=' +
		MAX_PACK;
	for (const { path, bytes } of input.packs) {
		const name = /^objects\/pack\/(pack-[0-9a-f]+)\.pack$/.exec(path)?.[1];
		if (!name) {
			refused.push({ path, reason: "is not a pack's path" });
			continue;
		}
		if ((Buffer.isBuffer(bytes) ? bytes.length : bytes.size) > MAX_PACK) {
			refused.push({
				path,
				reason: `is a pack over ${MAX_PACK / 1024 / 1024} MiB, which the sandbox does not publish: fetch it outside Prism`,
			});
			continue;
		}
		const result = await run(
			input.sandbox.bwrap,
			[
				"--unshare-all",
				"--die-with-parent",
				"--new-session",
				...systemArgs(),
				"--proc",
				"/proc",
				"--dev",
				"/dev",
				"--tmpfs",
				"/tmp",
				"--bind",
				work,
				"/work",
				...mounts,
				"--chdir",
				"/work",
				"--seccomp",
				"3",
				"--",
				"/bin/sh",
				"-c",
				script,
				"sh",
				input.format,
				...alternates,
			],
			bytes,
			input.sandbox.seccomp,
		);
		const written = /^pack\t([0-9a-f]+)\n$/.exec(result.stdout)?.[1];
		if (result.status !== 0 || !written) {
			// Git says what is wrong on its `error:` lines, then that it stops on a `fatal:` one.
			const said = result.stderr
				.split("\n")
				.filter((line) => /^(error|fatal): /.test(line))
				.map((line) => line.replace(/^(error|fatal): /, ""));
			const why = (result.error ?? said.join("; ")).slice(0, 300);
			refused.push({ path, reason: `is a pack Git refused: ${why || `exit ${result.status}`}` });
			continue;
		}
		if (`pack-${written}` !== name) {
			refused.push({ path, reason: `is named after another pack than its content (pack-${written})` });
			continue;
		}
		const idx = await readOwn(join(work, "repo", "objects", "pack", `${name}.idx`), MAX_PACK);
		const names = idx && indexNames(idx, input.format);
		if (!idx || !names) {
			refused.push({ path, reason: "is a pack whose rebuilt index could not be read" });
			continue;
		}
		const store = gitObjectStore(join(work, "repo", "objects"), input.format);
		try {
			const objects = new Map<string, ObjectType>();
			for (const oid of names) {
				const type = await store.type(oid);
				if (!type) break;
				objects.set(oid, type);
			}
			if (objects.size !== names.length) refused.push({ path, reason: "is a pack with an entry of unknown type" });
			else packs.set(path, { objects, idx });
		} finally {
			await store.close();
		}
	}
	return { packs, refused };
}
