// Real mount-boundary regressions. All repositories, configuration and hook markers are disposable.
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import {
	buildLayout,
	bwrapArgs,
	DEFAULT_SANDBOX_SETTINGS,
	prepareLayout,
	type SandboxLayout,
	type SandboxSettings,
} from "../src/fork/sandbox/layout.ts";
import { sandboxPromptSection, sandboxResultNote } from "../src/fork/sandbox/notes.ts";
import { HostPolicy } from "../src/fork/sandbox/proxy.ts";
import { startSandbox } from "../src/fork/sandbox/runtime.ts";

const bwrap = spawnSync("which", ["bwrap"], { encoding: "utf8" }).stdout.trim();
// Reading everything: these tests set Git's identity in a file of the home folder, which the limited home does not
// show outside the Git rule; they test Git's protections, which do not depend on it.
const SETTINGS: SandboxSettings = {
	...DEFAULT_SANDBOX_SETTINGS,
	read: { ...DEFAULT_SANDBOX_SETTINGS.read, limit: "all" },
};

describe.skipIf(!bwrap)("fork: Git metadata mount boundary", () => {
	let root: string;
	let home: string;
	let repo: string;
	let agent: string;
	let env: NodeJS.ProcessEnv;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-git-pin-"));
		// Beside the root, which some tests make writable: a writable folder holding the home folder is refused (Q-L12).
		home = mkdtempSync(join(tmpdir(), "prism-git-pin-home-"));
		repo = join(root, "project");
		agent = join(home, "agent");
		mkdirSync(agent, { recursive: true });
		mkdirSync(join(home, "xdg"));
		writeFileSync(
			join(home, "gitconfig"),
			"[user]\nname = Sandbox Test\nemail = sandbox@example.invalid\n[commit]\ngpgSign = false\n",
		);
		env = {
			PATH: process.env.PATH,
			HOME: home,
			XDG_CONFIG_HOME: join(home, "xdg"),
			GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
			GIT_CONFIG_NOSYSTEM: "1",
			[ENV_AGENT_DIR]: agent,
		};
		for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) vi.stubEnv(key, undefined);
		for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
		git(root, "init", "-q", "--initial-branch=main", repo);
		git(repo, "commit", "--allow-empty", "-qm", "initial");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	function git(cwd: string, ...args: string[]): string {
		return execFileSync("git", ["-C", cwd, ...args], {
			env,
			encoding: "utf8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
	}
	function layout(cwd = repo, allowWrite: string[] = []): SandboxLayout {
		return buildLayout({ cwd, home, agentDir: agent, settings: { ...SETTINGS, allowWrite } });
	}
	function run(plan: SandboxLayout, argv: string[], originalArgs?: string[]): string {
		if (!originalArgs) prepareLayout(plan);
		const args = originalArgs ?? bwrapArgs(plan, (path) => statSync(path).isDirectory(), join(agent, "unreadable"));
		const result = spawnSync(bwrap, [...args, "--", ...argv], {
			env,
			encoding: "utf8",
			timeout: 15_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		expect(result.error, result.stderr).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		return result.stdout;
	}
	// What the user creates, outside the sandbox, so that a relative core.hooksPath no longer refuses commands.
	function allowReceived(value: string, gitdir = join(repo, ".git")): string {
		const folder = resolve(gitdir, value);
		mkdirSync(folder, { recursive: true });
		return folder;
	}
	function script(name: string, source: string): string {
		const path = join(repo, name);
		writeFileSync(path, source);
		return path;
	}

	it("the identical rename/rebuild trigger runs a host hook on original dev, and is stopped after the fix", () => {
		const trigger = script(
			"replace.cjs",
			`const fs = require('node:fs');
const [repo, marker] = process.argv.slice(2);
console.log('ATTEMPTED');
fs.writeFileSync(repo + '/ordinary-control', 'writable');
try { fs.renameSync(repo + '/.git', repo + '/.git-old'); }
catch (error) { if (!['EBUSY', 'EROFS', 'EPERM', 'EACCES'].includes(error.code)) throw error;
console.log('STOPPED:' + error.code); process.exit(0); }
fs.cpSync(repo + '/.git-old', repo + '/.git', {recursive:true});
fs.writeFileSync(repo + '/.git/hooks/pre-commit', '#!/bin/sh\\nprintf HOST-HOOK > ' + JSON.stringify(marker) + '\\n', {mode:0o755});
console.log('INSTALLED');
`,
		);
		// Snapshot of dev 8149bbfd3, retained so the same regression also runs in shallow checkouts.
		const packageRoot = resolve(".");
		let source = readFileSync(new URL("./fixtures/sandbox-layout-before-git-pin.ts.txt", import.meta.url), "utf8");
		for (const [from, to] of [
			["../../config.ts", "src/config.ts"],
			["../global-settings.ts", "src/fork/global-settings.ts"],
			["./proxy.ts", "src/fork/sandbox/proxy.ts"],
		])
			source = source.replaceAll(JSON.stringify(from), JSON.stringify(join(packageRoot, to!)));
		const original = join(root, "original-layout.ts");
		writeFileSync(original, source);
		const loader = join(root, "original-args.mjs");
		writeFileSync(
			loader,
			`import {buildLayout,bwrapArgs} from ${JSON.stringify(original)};\nimport {statSync} from 'node:fs';\nconst input=JSON.parse(process.argv[2]);\nconsole.log(JSON.stringify(bwrapArgs(buildLayout(input), p=>statSync(p).isDirectory(), input.agentDir+'/unreadable')));\n`,
		);
		for (const version of ["original", "fixed"]) {
			const target = join(root, version);
			git(root, "clone", "-q", repo, target);
			const trusted = join(target, ".git/hooks/pre-commit");
			const trustedMarker = join(root, `${version}-trusted-marker`);
			writeFileSync(trusted, `#!/bin/sh\nprintf TRUSTED-HOOK > ${JSON.stringify(trustedMarker)}\n`, { mode: 0o755 });
			const marker = join(root, `${version}-host-marker`);
			const plan = layout(target);
			const args: string[] | undefined =
				version === "original"
					? JSON.parse(
							execFileSync(
								process.execPath,
								[
									loader,
									JSON.stringify({
										cwd: target,
										home,
										agentDir: agent,
										settings: SETTINGS,
									}),
								],
								{ env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
							),
						)
					: undefined;
			const output = run(plan, [process.execPath, trigger, target, marker], args);
			expect(output).toContain("ATTEMPTED");
			expect(readFileSync(join(target, "ordinary-control"), "utf8")).toBe("writable");
			// A successful host commit in BOTH cases excludes sandbox/host-Git startup failure as the oracle.
			git(target, "commit", "--allow-empty", "-m", "host control");
			expect(git(target, "log", "-1", "--format=%s").trim()).toBe("host control");
			if (version === "original") {
				expect(output).toContain("INSTALLED");
				expect(readFileSync(marker, "utf8")).toBe("HOST-HOOK");
			} else {
				expect(output).toMatch(/STOPPED:(EBUSY|EROFS|EPERM|EACCES)/);
				expect(readFileSync(trustedMarker, "utf8")).toBe("TRUSTED-HOOK");
				expect(existsSync(marker)).toBe(false);
			}
		}
	});

	function attack(plan: SandboxLayout, paths: string[]): void {
		const path = script(
			"mutate.py",
			`import ctypes, errno, json, os, shutil, sys
paths = json.loads(sys.argv[1])
libc = ctypes.CDLL(None, use_errno=True)
print('STARTED')
open('ordinary-control', 'w').write('writable')
def denied(label, fn):
    try: fn()
    except OSError as e:
        assert e.errno in (errno.EBUSY, errno.EROFS, errno.EPERM, errno.EACCES, errno.EEXIST, errno.ENOTEMPTY, errno.EISDIR, errno.EXDEV), (label, e)
        print('STOPPED:' + label)
    else: raise AssertionError('attack succeeded: ' + label)
for index, p in enumerate(paths):
    denied(p + ':rename', lambda: os.rename(p, p + '.moved'))
    def native():
        if libc.rename(os.fsencode(p), os.fsencode(p + '.native')) != 0:
            raise OSError(ctypes.get_errno(), 'native rename')
    denied(p + ':native', native)
    replacement = os.path.abspath('replacement-%d' % index)
    if os.path.isdir(p): os.mkdir(replacement)
    else: open(replacement, 'w').close()
    denied(p + ':replace', lambda: os.replace(replacement, p))
    if os.path.isdir(replacement): os.rmdir(replacement)
    else: os.unlink(replacement)
    denied(p + ':symlink', lambda: os.symlink('/tmp/attacker', p))
    def recreate():
        if os.path.islink(p): os.unlink(p)
        elif os.path.isdir(p): shutil.rmtree(p)
        else: os.unlink(p)
        os.symlink('/tmp/attacker', p)
    denied(p + ':delete-recreate', recreate)
print('COMPLETE')
`,
		);
		const output = run(plan, ["python3", path, JSON.stringify(paths)]);
		expect(output).toContain("STARTED");
		expect(output).toContain("COMPLETE");
		expect(output.match(/STOPPED:/g)).toHaveLength(paths.length * 5);
	}

	it("blocks replacement through every writable ancestor of .git, .pi and external project configuration", () => {
		const project = join(repo, "nested/project");
		mkdirSync(project, { recursive: true });
		for (const name of new Set([".pi", CONFIG_DIR_NAME])) {
			mkdirSync(join(project, name));
			writeFileSync(join(project, name, "settings.json"), '{"trusted":true}');
		}
		const external = join(root, "external/a/b");
		mkdirSync(join(external, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(join(external, CONFIG_DIR_NAME, "settings.json"), '{"trusted":true}');
		const plan = layout(project, [repo, join(root, "external"), external]);
		attack(plan, [
			join(project, ".pi"),
			...(CONFIG_DIR_NAME === ".pi" ? [] : [join(project, CONFIG_DIR_NAME)]),
			project,
			dirname(project),
			join(repo, ".git/hooks"),
			join(repo, ".git"),
			join(external, CONFIG_DIR_NAME),
			external,
			dirname(external),
		]);
	});

	it.each(["nested/hooks", "../external/a/hooks", "absolute", "missing/a/hooks"])(
		"protects core.hooksPath %s and all its writable parents",
		(value) => {
			const hooks = value === "absolute" ? join(root, "external/a/hooks") : resolve(repo, value);
			if (!value.startsWith("missing")) mkdirSync(hooks, { recursive: true });
			git(repo, "config", "core.hooksPath", value === "absolute" ? hooks : value);
			const received = value === "absolute" ? undefined : allowReceived(value);
			const plan = layout(repo, [root]);
			const reserved =
				plan.missing?.find((entry) => hooks.startsWith(`${entry.path}/`) || hooks === entry.path)?.path ?? hooks;
			const parents = [reserved];
			for (let folder = dirname(reserved); folder !== repo && folder !== root; folder = dirname(folder))
				parents.push(folder);
			if (received) {
				parents.push(received);
				for (
					let folder = dirname(received);
					folder !== join(repo, ".git") && folder !== repo;
					folder = dirname(folder)
				)
					parents.push(folder);
			}
			attack(plan, parents);
		},
	);

	it("protects a symlinked hooks target and parent, including their entries", () => {
		mkdirSync(join(repo, "tool/real/hooks"), { recursive: true });
		symlinkSync("real", join(repo, "tool/link"));
		git(repo, "config", "core.hooksPath", "tool/link/hooks");
		allowReceived("tool/link/hooks");
		const plan = layout();
		expect(plan.blocked).toBeUndefined();
		attack(plan, [
			join(repo, "tool/link"),
			join(repo, "tool/real/hooks"),
			join(repo, "tool/real"),
			join(repo, "tool"),
		]);
	});

	it.each([".pi", ".git", "hooks-root", "hooks-git-state"])(
		"restricts risky writes while keeping reads available for an inseparable protected root: %s",
		async (kind) => {
			if (kind === ".pi" || kind === ".git") {
				const target = join(root, `real-${kind}`);
				if (kind === ".git") renameSync(join(repo, kind), target);
				else mkdirSync(target);
				symlinkSync(target, join(repo, kind));
			} else {
				git(repo, "config", "core.hooksPath", kind === "hooks-root" ? "." : ".git");
				if (kind === "hooks-git-state") allowReceived(".git");
			}
			const plan = layout();
			expect(plan.blocked).toBeUndefined();
			expect(plan.restrictions?.length).toBeGreaterThan(0);
			const denied = kind === "hooks-git-state" ? join(repo, ".git/config.worktree") : join(repo, "denied");
			const check = script(
				"restriction.cjs",
				`const fs = require('node:fs');
console.log(fs.readFileSync('.git/HEAD', 'utf8'));
try { fs.writeFileSync(${JSON.stringify(denied)}, 'changed'); throw new Error('write unexpectedly allowed'); }
catch (error) { if (!['EBUSY', 'EROFS', 'EPERM', 'EACCES'].includes(error.code)) throw error; }
console.log('READS-AVAILABLE');`,
			);
			expect(run(plan, [process.execPath, check])).toContain("READS-AVAILABLE");
			const reason = plan.restrictions![0]!.reason;
			expect(sandboxPromptSection(plan)).toContain(reason);
			expect(sandboxResultNote("Read-only file system", plan)).toContain(reason);
			expect(sandboxResultNote("Read-only file system", plan)).toContain("sandbox stays on");
			const privateTmp = join(root, "private-tmp");
			mkdirSync(privateTmp);
			expect(
				await startSandbox(
					SETTINGS,
					repo,
					new HostPolicy(() => DEFAULT_SANDBOX_SETTINGS.network, undefined),
					privateTmp,
				),
			).not.toHaveProperty("error");
		},
	);

	it("protects linked .git/gitdir/commondir/common hooks and config, while Git remains writable", () => {
		const linked = join(root, "linked");
		git(repo, "worktree", "add", "-qb", "linked", linked);
		const gitdir = git(linked, "rev-parse", "--absolute-git-dir").trim();
		const plan = layout(linked, [root]);
		const output = run(plan, ["git", "commit", "--allow-empty", "-m", "linked commit"]);
		expect(output).toContain("linked commit");
		expect(git(linked, "log", "-1", "--format=%s").trim()).toBe("linked commit");
		attack(layout(linked, [root]), [
			join(linked, ".git"),
			join(gitdir, "gitdir"),
			join(gitdir, "commondir"),
			join(gitdir, "config.worktree"),
			gitdir,
			dirname(gitdir),
			join(repo, ".git/hooks"),
			join(repo, ".git/config"),
			join(repo, ".git"),
		]);
	});

	it("keeps add, commit, local-file fetch and worktree add/list/remove working", () => {
		const remote = join(root, "remote.git");
		git(root, "clone", "-q", "--bare", repo, remote);
		git(repo, "remote", "add", "local", `file://${remote}`);
		const control = script(
			"git-control.cjs",
			`const fs=require('node:fs'), {execFileSync}=require('node:child_process');
function git(...args) { return execFileSync('git',args,{encoding:'utf8'}); }
fs.writeFileSync('tracked','new data'); git('add','tracked'); git('commit','-m','sandbox commit');
git('fetch','local'); git('worktree','add','-b','temporary','other');
if (!git('worktree','list').includes('temporary')) throw Error('missing worktree');
git('worktree','remove','other'); console.log('GIT-CONTROLS-PASSED');
`,
		);
		expect(run(layout(), [process.execPath, control])).toContain("GIT-CONTROLS-PASSED");
		expect(git(repo, "show", "HEAD:tracked")).toBe("new data");
		expect(git(repo, "rev-parse", "refs/remotes/local/main")).toBe(git(remote, "rev-parse", "main"));
	});

	it.each(["configuration", "hooks"])("keeps /dev/null writable when it disables Git %s", (kind) => {
		if (kind === "configuration") vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
		else git(repo, "config", "core.hooksPath", "/dev/null");
		const plan = layout();
		expect(plan.readOnly).not.toContain("/dev/null");
		expect(run(plan, ["sh", "-c", "printf control >/dev/null && printf OK"])).toBe("OK");
	});

	// fork: a hook, configuration or commondir written to a
	// submodule's Git directory ran at the user's next host git command in the submodule.
	describe("submodules", () => {
		let modules: string;
		let inner: string;
		beforeEach(() => {
			const library = join(root, "library");
			const nested = join(root, "nested");
			for (const path of [nested, library]) {
				git(root, "init", "-q", "--initial-branch=main", path);
				if (path === library) {
					git(library, "-c", "protocol.file.allow=always", "submodule", "add", "-q", nested, "inner");
				}
				git(path, "commit", "--allow-empty", "-qm", "initial");
			}
			git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "sub");
			git(repo, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init", "--recursive");
			git(repo, "commit", "-qm", "sub");
			modules = join(repo, ".git/modules/sub");
			inner = join(modules, "modules/inner");
		});

		it("keeps each submodule's Git directory and .git file read-only, nested ones included", () => {
			expect(existsSync(join(inner, "HEAD"))).toBe(true);
			const plan = layout();
			expect(plan.readOnly).toEqual(expect.arrayContaining([modules, inner]));
			attack(plan, [
				modules,
				join(modules, "hooks"),
				join(modules, "config"),
				join(modules, "HEAD"),
				inner,
				join(inner, "hooks"),
				join(repo, "sub/.git"),
				join(repo, "sub/inner/.git"),
			]);
			const probe = script(
				"probe.sh",
				`for path in .git/modules/sub/commondir .git/modules/sub/modules/inner/commondir .git/modules/sub/hooks/pre-commit; do
	( : > "$path" ) 2>/dev/null && echo "CREATED $path"
done
printf data > sub/tracked && echo SOURCE-WRITABLE
git -C sub add tracked 2>&1 | grep -q 'Read-only file system' && echo ADD-REFUSED
git submodule status --recursive > /dev/null && git -C sub log -1 --format=%s > /dev/null && git -C sub/inner status --short > /dev/null && echo READS-WORK
printf top > top && git add top && git commit -qm top && echo PROJECT-COMMIT
`,
			);
			const output = run(layout(), ["sh", probe]);
			expect(output).not.toContain("CREATED");
			for (const marker of ["SOURCE-WRITABLE", "ADD-REFUSED", "READS-WORK", "PROJECT-COMMIT"]) {
				expect(output).toContain(marker);
			}
			expect(existsSync(join(modules, "commondir"))).toBe(false);
			expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("top");
			// The model is told why, and that the sandbox stays on.
			const restriction = plan.restrictions?.find(({ path }) => path === modules);
			expect(restriction?.reason).toContain("submodule Git metadata");
			expect(sandboxResultNote("fatal: Unable to create 'index.lock': Read-only file system", plan)).toContain(
				"submodule Git metadata",
			);
			expect(sandboxPromptSection(plan)).toContain("must run outside it");
		});

		it("stops a commondir redirect that would run a hook at the next host commit in the submodule", () => {
			const marker = join(root, "host-marker");
			const redirect = script(
				"redirect.sh",
				`cp -r .git/modules/sub evil 2>/dev/null
printf '#!/bin/sh\\nprintf HOST-HOOK > ${marker}\\n' > evil/hooks/pre-commit && chmod +x evil/hooks/pre-commit
if printf '%s\\n' "$PWD/evil" > .git/modules/sub/commondir 2>/dev/null; then echo REDIRECTED; else echo STOPPED; fi
printf data > source-control && echo SOURCE-WRITABLE
`,
			);
			const output = run(layout(), ["sh", redirect]);
			expect(output).toContain("SOURCE-WRITABLE");
			expect(output).toContain("STOPPED");
			// The user's next commit in the submodule, on the host: no foreign hook runs, the commit succeeds.
			git(join(repo, "sub"), "commit", "--allow-empty", "-qm", "host commit");
			expect(existsSync(marker)).toBe(false);
			expect(git(join(repo, "sub"), "log", "-1", "--format=%s").trim()).toBe("host commit");
		});

		it("finds submodules from their Git directories alone, even without HEAD or .gitmodules", () => {
			// A command can rewrite .gitmodules; the Git directories themselves are what is protected.
			for (const path of [repo, join(repo, "sub")]) writeFileSync(join(path, ".gitmodules"), "");
			const plan = layout();
			expect(plan.readOnly).toEqual(expect.arrayContaining([join(repo, "sub/.git"), join(repo, "sub/inner/.git")]));
			rmSync(join(inner, "HEAD"));
			rmSync(join(modules, "HEAD"));
			expect(layout().readOnly).toEqual(expect.arrayContaining([modules, inner]));
		});

		it("keeps the modules folder read-only, so no marker or new Git directory can be planted", () => {
			git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", join(root, "nested"), "libs/third");
			writeFileSync(join(repo, ".gitmodules"), "");
			const probe = script(
				"plant.sh",
				`for path in .git/modules/libs/config .git/modules/libs/HEAD .git/modules/evil; do
	( mkdir -p "$path" ) 2>/dev/null && echo "PLANTED $path"
done
echo DONE
`,
			);
			const plan = layout();
			expect(plan.readOnly).toContain(join(repo, ".git/modules"));
			const output = run(plan, ["sh", probe]);
			expect(output).toContain("DONE");
			expect(output).not.toContain("PLANTED");
			expect(plan.restrictions?.find(({ path }) => path === join(repo, ".git/modules"))?.reason).toContain(
				"submodule Git metadata",
			);
		});

		it("protects what a submodule's hooks, configuration or commondir link to", () => {
			const hooks = join(repo, "linked-hooks");
			mkdirSync(hooks);
			rmSync(join(modules, "hooks"), { recursive: true, force: true });
			symlinkSync(hooks, join(modules, "hooks"));
			const common = join(repo, "foreign");
			git(root, "init", "-q", "--initial-branch=main", common);
			writeFileSync(join(inner, "commondir"), `${join(common, ".git")}\n`);
			attack(layout(), [hooks, join(common, ".git/hooks"), join(common, ".git/config")]);
		});

		it("follows a core.worktree set in an included file", () => {
			const config = join(modules, "config");
			const worktree = git(modules, "config", "--file", config, "core.worktree").trim();
			git(modules, "config", "--file", config, "--unset", "core.worktree");
			writeFileSync(join(modules, "worktree.inc"), `[core]\n\tworktree = ${worktree}\n`);
			git(modules, "config", "--file", config, "include.path", "worktree.inc");
			writeFileSync(join(repo, ".gitmodules"), "");
			expect(git(join(repo, "sub"), "rev-parse", "--show-toplevel").trim()).toBe(join(repo, "sub"));
			attack(layout(), [join(repo, "sub/.git"), join(modules, "worktree.inc")]);
		});

		it("completes a submodule found without its working tree from .gitmodules", () => {
			git(modules, "config", "--file", join(modules, "config"), "--unset", "core.worktree");
			writeFileSync(
				join(home, "gitconfig"),
				`${readFileSync(join(home, "gitconfig"), "utf8")}[core]\nhooksPath = .githooks\n`,
			);
			allowReceived(".githooks");
			mkdirSync(join(repo, "sub/.githooks"));
			attack(layout(), [join(repo, "sub/.git"), join(repo, "sub/.githooks")]);
		});

		it("protects the files that hooks link to, in the project and in submodules", () => {
			mkdirSync(join(repo, "scripts"));
			for (const name of ["pre-commit", "post-checkout"]) {
				writeFileSync(join(repo, "scripts", name), "#!/bin/sh\n", { mode: 0o755 });
			}
			symlinkSync(join(repo, "scripts/pre-commit"), join(repo, ".git/hooks/pre-commit"));
			symlinkSync(join(repo, "scripts/post-checkout"), join(modules, "hooks/post-checkout"));
			attack(layout(), [join(repo, "scripts/pre-commit"), join(repo, "scripts/post-checkout")]);
		});

		it("follows a module folder that links to a Git directory elsewhere", () => {
			const moved = join(repo, "moved-gitdir");
			git(modules, "config", "--file", join(modules, "config"), "core.worktree", join(repo, "sub"));
			renameSync(modules, moved);
			symlinkSync(moved, modules);
			writeFileSync(join(repo, ".gitmodules"), "");
			expect(git(join(repo, "sub"), "rev-parse", "--git-dir").trim()).toBe(moved);
			attack(layout(), [join(moved, "hooks"), join(moved, "config")]);
		});

		it("visits each linked module folder once, so a link loop does not block the sandbox", () => {
			symlinkSync(join(repo, ".git/modules"), join(repo, ".git/modules/loop"));
			const plan = layout();
			expect(plan.blocked).toBeUndefined();
			attack(plan, [join(modules, "hooks")]);
		});

		it("protects the hooks path of a deinitialised submodule", () => {
			git(repo, "submodule", "deinit", "-q", "-f", "sub");
			expect(existsSync(join(repo, "sub/.git"))).toBe(false);
			mkdirSync(join(repo, "tools-hooks"));
			git(modules, "config", "--file", join(modules, "config"), "core.hooksPath", join(repo, "tools-hooks"));
			attack(layout(), [join(repo, "tools-hooks")]);
		});

		it("finds a submodule named like a Git file, such as libs/config", () => {
			git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", join(root, "nested"), "libs/config");
			writeFileSync(join(repo, ".gitmodules"), "");
			writeFileSync(
				join(home, "gitconfig"),
				`${readFileSync(join(home, "gitconfig"), "utf8")}[core]\nhooksPath = .githooks\n`,
			);
			allowReceived(".githooks");
			mkdirSync(join(repo, "libs/config/.githooks"));
			attack(layout(), [join(repo, "libs/config/.git"), join(repo, "libs/config/.githooks")]);
		});

		it("reads core.worktree as Git does, from config.worktree and conditional includes", () => {
			const config = join(modules, "config");
			const worktree = git(modules, "config", "--file", config, "core.worktree").trim();
			git(modules, "config", "--file", config, "--unset", "core.worktree");
			writeFileSync(join(repo, ".gitmodules"), "");
			git(modules, "config", "--file", config, "extensions.worktreeConfig", "true");
			git(modules, "config", "--file", join(modules, "config.worktree"), "core.worktree", worktree);
			expect(git(join(repo, "sub"), "config", "core.worktree").trim()).toBe(worktree);
			attack(layout(), [join(repo, "sub/.git")]);
			rmSync(join(modules, "config.worktree"));
			git(modules, "config", "--file", config, "--unset", "extensions.worktreeConfig");
			writeFileSync(join(modules, "worktree.inc"), `[core]\n\tworktree = ${worktree}\n`);
			git(modules, "config", "--file", config, `includeIf.gitdir:${modules}.path`, "worktree.inc");
			expect(git(join(repo, "sub"), "config", "core.worktree").trim()).toBe(worktree);
			attack(layout(), [join(repo, "sub/.git")]);
		});

		it("scans the submodules of a commondir's target", () => {
			const foreign = join(repo, "foreign");
			git(root, "init", "-q", "--initial-branch=main", foreign);
			git(foreign, "-c", "protocol.file.allow=always", "submodule", "add", "-q", join(root, "nested"), "fsub");
			writeFileSync(join(foreign, ".gitmodules"), "");
			writeFileSync(join(inner, "commondir"), `${join(foreign, ".git")}\n`);
			attack(layout(), [join(foreign, ".git/modules/fsub/hooks"), join(foreign, ".git/modules/fsub/config")]);
		});

		it("protects the .git file and hooks path of a submodule's linked worktree", () => {
			git(join(repo, "sub"), "worktree", "add", "-q", "-b", "side", join(repo, "sub-wt"));
			writeFileSync(
				join(home, "gitconfig"),
				`${readFileSync(join(home, "gitconfig"), "utf8")}[core]\nhooksPath = .githooks\n`,
			);
			allowReceived(".githooks");
			mkdirSync(join(repo, "sub-wt/.githooks"));
			attack(layout(), [join(repo, "sub-wt/.git"), join(repo, "sub-wt/.githooks")]);
		});

		it("protects what a linked worktree's commondir links to", () => {
			git(join(repo, "sub"), "worktree", "add", "-q", "-b", "side", join(repo, "sub-wt"));
			const own = join(modules, "worktrees/sub-wt");
			const pointer = join(repo, "commondir-target");
			writeFileSync(pointer, readFileSync(join(own, "commondir")));
			rmSync(join(own, "commondir"));
			symlinkSync(pointer, join(own, "commondir"));
			expect(git(join(repo, "sub-wt"), "rev-parse", "--is-inside-work-tree").trim()).toBe("true");
			attack(layout(), [pointer]);
		});

		it("keeps the path of a submodule whose name ends with a space", () => {
			git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", join(root, "library"), "spaced ");
			expect(existsSync(join(repo, "spaced /.git"))).toBe(true);
			attack(layout(), [join(repo, "spaced /.git")]);
		});

		it("analyses a submodule whose core.worktree names the superproject", () => {
			git(modules, "config", "--file", join(modules, "config"), "core.worktree", repo);
			mkdirSync(join(repo, "sub-hooks"));
			git(modules, "config", "--file", join(modules, "config"), "core.hooksPath", join(repo, "sub-hooks"));
			attack(layout(), [
				join(repo, "sub-hooks"),
				join(repo, ".git/hooks"),
				join(repo, ".git/config"),
				join(repo, "sub/.git"),
			]);
		});

		it("keeps a linked worktree's Git directory read-only when it links into the project", () => {
			git(join(repo, "sub"), "worktree", "add", "-q", "-b", "side", join(repo, "sub-wt"));
			const moved = join(repo, "worktree-meta");
			writeFileSync(join(modules, "worktrees/sub-wt/commondir"), `${modules}\n`);
			renameSync(join(modules, "worktrees/sub-wt"), moved);
			symlinkSync(moved, join(modules, "worktrees/sub-wt"));
			expect(git(join(repo, "sub-wt"), "rev-parse", "--is-inside-work-tree").trim()).toBe("true");
			attack(layout(), [join(moved, "commondir"), join(moved, "HEAD")]);
		});

		it("protects what another common directory of a linked worktree links to", () => {
			git(join(repo, "sub"), "worktree", "add", "-q", "-b", "side", join(repo, "sub-wt"));
			const other = join(repo, "other");
			git(root, "init", "-q", "--initial-branch=main", other);
			const hooks = join(repo, "other-hooks");
			mkdirSync(hooks);
			rmSync(join(other, ".git/hooks"), { recursive: true, force: true });
			symlinkSync(hooks, join(other, ".git/hooks"));
			writeFileSync(join(modules, "worktrees/sub-wt/commondir"), `${join(other, ".git")}\n`);
			attack(layout(), [hooks, join(other, ".git/config")]);
		});

		it("protects a push hooks folder that a relative hooks path names outside the Git directory", () => {
			const hooks = join(repo, "receive-hooks");
			mkdirSync(hooks);
			git(modules, "config", "--file", join(modules, "config"), "core.hooksPath", "../../../receive-hooks");
			attack(layout(), [hooks]);
		});

		it("protects what push hooks link to, through a hooks path relative to the Git directory", () => {
			git(modules, "config", "--file", join(modules, "config"), "core.hooksPath", "custom");
			mkdirSync(join(modules, "custom"));
			const payload = join(repo, "payload");
			writeFileSync(payload, "#!/bin/sh\n");
			symlinkSync(payload, join(modules, "custom/pre-receive"));
			attack(layout(), [payload]);
		});

		it("keeps the target of a linked modules folder read-only", () => {
			const linked = join(repo, "linked-modules");
			git(inner, "config", "--file", join(inner, "config"), "core.worktree", join(repo, "sub/inner"));
			renameSync(join(modules, "modules"), linked);
			symlinkSync(linked, join(modules, "modules"));
			expect(git(join(repo, "sub/inner"), "rev-parse", "--is-inside-work-tree").trim()).toBe("true");
			const probe = script(
				"plant-linked.sh",
				`( mkdir -p linked-modules/libs/config ) 2>/dev/null && echo PLANTED
echo DONE
`,
			);
			const output = run(layout(), ["sh", probe]);
			expect(output).toContain("DONE");
			expect(output).not.toContain("PLANTED");
			attack(layout(), [linked, join(linked, "inner/hooks")]);
		});

		it("refuses to start rather than skip submodule names nested too deeply", () => {
			mkdirSync(join(repo, ".git/modules", ...Array<string>(70).fill("n")), { recursive: true });
			expect(layout().blocked).toContain("nested too deeply");
		});

		it("finds a submodule whose name has a slash", () => {
			git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", join(root, "nested"), "libs/third");
			const gitdir = join(repo, ".git/modules/libs/third");
			expect(existsSync(join(gitdir, "HEAD"))).toBe(true);
			writeFileSync(join(repo, ".gitmodules"), "");
			attack(layout(), [join(gitdir, "hooks"), join(gitdir, "config"), join(repo, "libs/third/.git")]);
		});

		it("finds a submodule whose Git directory is inside it, from .gitmodules", () => {
			const embedded = join(repo, "embedded");
			git(root, "init", "-q", "--initial-branch=main", embedded);
			git(embedded, "commit", "--allow-empty", "-qm", "embedded");
			git(repo, "submodule", "add", "-q", "./embedded", "embedded");
			expect(statSync(join(embedded, ".git")).isDirectory()).toBe(true);
			const plan = layout();
			expect(plan.readOnly).toContain(join(embedded, ".git"));
			attack(plan, [join(embedded, ".git/hooks"), join(embedded, ".git/config")]);
		});

		it("protects a hooks path that the global configuration names relative to each submodule", () => {
			writeFileSync(
				join(home, "gitconfig"),
				`${readFileSync(join(home, "gitconfig"), "utf8")}[core]\nhooksPath = .githooks\n`,
			);
			allowReceived(".githooks");
			mkdirSync(join(repo, "sub/.githooks"));
			attack(layout(), [join(repo, "sub/.githooks")]);
		});
	});

	it("protects the Git metadata of a second repository opened for writing, as the project's", () => {
		const second = join(root, "second");
		git(root, "init", "-q", "--initial-branch=main", second);
		mkdirSync(join(second, ".githooks"));
		git(second, "config", "core.hooksPath", ".githooks");
		const hook = join(second, "scripts/pre-commit");
		mkdirSync(dirname(hook));
		writeFileSync(hook, "#!/bin/sh\n");
		symlinkSync(hook, join(second, ".git/hooks/pre-commit"));
		// The relative hooks path is refused until its folder in the Git directory exists, as in the project.
		expect(layout(repo, [second]).blocked).toContain(join(second, ".git/.githooks"));
		const received = allowReceived(".githooks", join(second, ".git"));
		const plan = layout(repo, [second]);
		attack(plan, [
			join(second, ".git/hooks"),
			join(second, ".git/config"),
			join(second, ".githooks"),
			received,
			hook,
		]);
		const output = run(layout(repo, [second]), ["sh", "-c", `printf x > ${second}/source && echo WROTE`]);
		expect(output).toContain("WROTE");
	});

	it("protects the configuration of an existing sibling worktree", () => {
		const sibling = join(root, "sibling");
		git(repo, "worktree", "add", "-qb", "sibling", sibling);
		git(repo, "config", "extensions.worktreeConfig", "true");
		git(sibling, "config", "--worktree", "user.name", "Sibling");
		const gitdir = git(sibling, "rev-parse", "--absolute-git-dir").trim();
		attack(layout(), [join(gitdir, "config.worktree"), join(gitdir, "commondir"), gitdir]);
	});

	it("pins writable parents of an agent configuration outside cwd", () => {
		const privateRoot = join(root, "external/private");
		const config = join(privateRoot, "config/agent");
		mkdirSync(config, { recursive: true });
		const plan = buildLayout({
			cwd: repo,
			home,
			agentDir: config,
			settings: {
				...SETTINGS,
				allowWrite: [join(root, "external")],
			},
		});
		attack(plan, [dirname(config), privateRoot]);
	});

	it("preserves core.worktree, allowing reads and source writes while refusing Git metadata writes", async () => {
		const actual = join(repo, "actual");
		mkdirSync(actual);
		git(repo, "config", "core.worktree", actual);
		const before = git(repo, "rev-parse", "--show-toplevel");
		const plan = layout();
		expect(plan.blocked).toBeUndefined();
		expect(plan.restrictions).toEqual([
			{ path: join(repo, ".git"), reason: expect.stringContaining(`core.worktree=${actual}`) },
		]);
		expect(
			run(plan, [
				"sh",
				"-ec",
				"git --no-optional-locks status --short; printf safe >actual/new; if git add new 2>/dev/null; then exit 1; fi; printf READS-AND-SOURCE-WRITES-AVAILABLE",
			]),
		).toContain("READS-AND-SOURCE-WRITES-AVAILABLE");
		expect(git(repo, "rev-parse", "--show-toplevel")).toBe(before);
		expect(existsSync(join(repo, ".git/commondir"))).toBe(false);
		const privateTmp = join(root, "private-tmp");
		mkdirSync(privateTmp);
		expect(
			await startSandbox(
				SETTINGS,
				repo,
				new HostPolicy(() => DEFAULT_SANDBOX_SETTINGS.network, undefined),
				privateTmp,
			),
		).not.toHaveProperty("error");
	});

	it("protects hook paths in a currently inactive conditional configuration", () => {
		const hooks = join(repo, "conditional/hooks");
		mkdirSync(hooks, { recursive: true });
		const included = join(repo, "conditional.cfg");
		writeFileSync(included, "[core]\nhooksPath = conditional/hooks\n");
		git(repo, "config", "includeIf.onbranch:other.path", included);
		allowReceived("conditional/hooks");
		attack(layout(), [hooks, dirname(hooks), included]);
	});

	it("resolves a parent component after following a symbolic hook path", () => {
		const tools = join(repo, "tools");
		const external = join(root, "external");
		mkdirSync(tools);
		mkdirSync(join(external, "deep"), { recursive: true });
		mkdirSync(join(external, "hooks"));
		symlinkSync(join(external, "deep"), join(tools, "link"));
		git(repo, "config", "core.hooksPath", "tools/link/../hooks");
		const plan = layout(repo, [external]);
		// In the Git directory, tools/link does not exist and the command could create it as a link.
		expect(plan.blocked).toContain('through a folder name followed by ".."');
		attack({ ...plan, blocked: undefined }, [join(external, "hooks"), join(tools, "link")]);
	});

	describe("relative core.hooksPath and pushes received by the repository", () => {
		const plant = `mkdir -p .git/.husky/_ && printf '#!/bin/sh\\ntouch %s\\n' "$1" > .git/.husky/_/pre-receive && chmod +x .git/.husky/_/pre-receive && printf PLANTED`;
		function push(): void {
			const client = join(root, "client");
			if (!existsSync(client)) git(root, "clone", "-q", repo, client);
			git(client, "commit", "--allow-empty", "-qm", "pushed");
			git(client, "push", "-q", "origin", "HEAD:refs/heads/received");
		}
		beforeEach(() => {
			// husky 9 writes this value.
			git(repo, "config", "core.hooksPath", ".husky/_");
			mkdirSync(join(repo, ".husky/_"), { recursive: true });
		});

		it("refuses commands while the folder is missing, without creating it, and names the configuration", async () => {
			const marker = join(root, "host-marker");
			const plan = layout();
			expect(plan.blocked).toContain("core.hooksPath=.husky/_ in file:.git/config is relative");
			expect(plan.blocked).toContain(`mkdir -p '${join(repo, ".git/.husky/_")}'`);
			expect(() => prepareLayout(plan)).toThrow(plan.blocked);
			expect(existsSync(join(repo, ".git/.husky"))).toBe(false);
			const privateTmp = join(root, "private-tmp");
			mkdirSync(privateTmp);
			// The startup check judges the layout the commands get, with their private Git copy, so it starts (SEC-08).
			const started = await startSandbox(
				SETTINGS,
				repo,
				new HostPolicy(() => DEFAULT_SANDBOX_SETTINGS.network, undefined),
				privateTmp,
			);
			expect(started).not.toHaveProperty("error");
			expect(existsSync(join(repo, ".git/.husky"))).toBe(false);
			// Without the refusal, the command plants a hook that the next push received runs on the host.
			const unchecked = { ...layout(), blocked: undefined };
			expect(run(unchecked, ["sh", "-ec", plant, "plant", marker])).toBe("PLANTED");
			push();
			expect(existsSync(marker)).toBe(true);
		});

		it("keeps the folder read-only once the user creates it, with source and Git writes available", () => {
			const marker = join(root, "host-marker");
			const received = allowReceived(".husky/_");
			const plan = layout();
			expect(plan.blocked).toBeUndefined();
			expect(
				run(plan, [
					"sh",
					"-ec",
					`printf safe > source-control; git add source-control; git commit -qm sandboxed; if (${plant}) 2>/dev/null; then exit 1; fi; printf STOPPED`,
					"plant",
					marker,
				]),
			).toBe("STOPPED");
			expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("sandboxed");
			push();
			expect(existsSync(marker)).toBe(false);
			attack(layout(), [received, dirname(received)]);
		});

		it("checks the Git directory of a linked worktree, where its pushes run hooks", () => {
			const linked = join(root, "linked");
			git(repo, "worktree", "add", "-q", "-b", "side", linked);
			const own = join(repo, ".git/worktrees/linked/.husky/_");
			expect(layout(linked).blocked).toContain(`mkdir -p '${own}'`);
			mkdirSync(own, { recursive: true });
			// A push to the main worktree runs hooks from the common Git directory, which the sandbox also opens.
			expect(layout(linked).blocked).toContain(`mkdir -p '${join(repo, ".git/.husky/_")}'`);
			allowReceived(".husky/_");
			expect(layout(linked).blocked).toBeUndefined();
		});

		it.each([
			["an absolute path", () => join(repo, "absent-hooks")],
			["/dev/null", () => "/dev/null"],
			["a relative path outside every writable folder", () => "../../outside-hooks"],
		])("does not refuse %s", (_label, value) => {
			git(repo, "config", "core.hooksPath", value());
			expect(layout().blocked).toBeUndefined();
		});
	});

	// Owner: an empty `.git` skeleton in the home folder (another tool's sandbox left one) restricted every
	// command's writes. Git ignores a `.git` without HEAD; Prism keeps it read-only and says nothing.
	it("ignores an incomplete .git above the project, which stays read-only", () => {
		mkdirSync(join(root, ".git/info"), { recursive: true });
		writeFileSync(join(root, ".git/config.worktree"), "");
		const plan = layout();
		expect(plan.blocked).toBeUndefined();
		expect(plan.restrictions ?? []).toEqual([]);
		expect(
			run(plan, [
				"sh",
				"-ec",
				`printf safe > source-control; if touch ${JSON.stringify(join(root, ".git/HEAD"))} 2>/dev/null; then exit 1; fi; printf SOURCE-WRITABLE`,
			]),
		).toBe("SOURCE-WRITABLE");
	});

	it("keeps incomplete Git metadata read-only while source writes remain available", () => {
		rmSync(join(repo, ".git/HEAD"));
		const plan = layout();
		expect(plan.restrictions?.[0]?.reason).toContain("incomplete Git metadata");
		expect(
			run(plan, [
				"sh",
				"-ec",
				"printf safe > source-control; if touch .git/HEAD 2>/dev/null; then exit 1; fi; printf SOURCE-WRITABLE",
			]),
		).toBe("SOURCE-WRITABLE");
	});
});
