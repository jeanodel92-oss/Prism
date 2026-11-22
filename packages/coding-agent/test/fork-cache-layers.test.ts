// fork: the package caches a sandboxed command writes are shown through a layer
// of its own (an overlay over the real cache, or the project's private cache without overlays), so nothing it
// writes there runs outside the sandbox later. The end-to-end cases replay the audit's probe
// with the real runtime and bubblewrap.
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { cacheLayers, overlaysWork } from "../src/fork/sandbox/cache-layers.ts";
import {
	buildLayout,
	bwrapArgs,
	DEFAULT_SANDBOX_SETTINGS,
	parseSandboxSettings,
	prepareLayout,
	type SandboxLayout,
} from "../src/fork/sandbox/layout.ts";
import { findBwrap, removeSessionTmpDir } from "../src/fork/sandbox/runtime.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./suite/harness.ts";

const bwrap = findBwrap();
const npm = spawnSync("npm", ["--version"], { timeout: 10_000, stdio: "ignore" }).status === 0;
const isDirectory = (path: string) => statSync(path).isDirectory();
/**
 * Whether this machine's file system takes an overlay in a user namespace. A container whose /var/tmp is itself an
 * overlay (the CI's runner) refuses it; Prism then falls back to private caches, tested below.
 */
const overlaysHere = ((): boolean => {
	if (!bwrap) return false;
	const probe = mkdtempSync("/var/tmp/prism-cache-layers-probe-");
	try {
		const cache = join(probe, ".npm");
		mkdirSync(cache);
		return overlaysWork(bwrap, [cache], join(probe, "layers"));
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
})();

describe("fork: package caches through layers (AS-010)", () => {
	let base: string;
	let home: string;
	let agentDir: string;
	let project: string;
	let harness: Harness | undefined;

	beforeEach(() => {
		// /tmp is replaced inside the sandbox; keep the throwaway home and project outside it.
		base = realpathSync(mkdtempSync("/var/tmp/prism-cache-layers-"));
		home = join(base, "home");
		agentDir = join(base, "agent");
		project = join(home, "project");
		for (const path of [project, agentDir, join(home, ".npm"), join(home, ".cargo", "registry")])
			mkdirSync(path, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
		vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
		vi.stubEnv("NPM_CONFIG_CACHE", undefined);
		vi.stubEnv("npm_config_cache", undefined);
	});

	afterEach(() => {
		if (harness) {
			removeSessionTmpDir(harness.sessionManager.getSessionId());
			harness.cleanup();
			harness = undefined;
		}
		vi.unstubAllEnvs();
		rmSync(base, { recursive: true, force: true });
	});

	const layout = (settings = parseSandboxSettings({ read: { limit: "all" } })) =>
		buildLayout({ cwd: project, home, agentDir, settings });

	describe("layout", () => {
		it("marks the package caches among the writable paths", () => {
			const plan = layout();
			expect(plan.caches).toEqual([join(home, ".npm"), join(home, ".cargo", "registry")]);
			expect(plan.writable).toEqual(expect.arrayContaining([project, ...plan.caches!]));
		});

		it("marks them when reading is limited to the project too", () => {
			const plan = layout(DEFAULT_SANDBOX_SETTINGS);
			expect(plan.caches).toEqual(expect.arrayContaining([join(home, ".npm"), join(home, ".cargo", "registry")]));
		});

		it("binds a cache the user made writable, or one that holds the project, as it is", () => {
			expect(layout(parseSandboxSettings({ read: { limit: "all" }, allowWrite: ["~/.npm"] })).caches).toEqual([
				join(home, ".cargo", "registry"),
			]);
			const inCache = join(home, ".npm", "work");
			mkdirSync(inCache);
			const plan = buildLayout({
				cwd: inCache,
				home,
				agentDir,
				settings: parseSandboxSettings({ read: { limit: "all" } }),
			});
			expect(plan.caches).toEqual([join(home, ".cargo", "registry")]);
		});

		it("mounts each cache through its layer, read-only without one", () => {
			const npmCache = join(home, ".npm");
			const cargo = join(home, ".cargo", "registry");
			const plan: SandboxLayout = {
				cwd: project,
				writable: [project, npmCache, cargo],
				readOnly: [],
				hidden: [],
				caches: [npmCache, cargo],
				cacheLayers: [{ path: npmCache, upper: "/layer/0/upper", work: "/layer/0/work" }],
			};
			const args = bwrapArgs(plan, () => true, "/unreadable").join(" ");
			expect(args).toContain(`--bind ${project} ${project}`);
			expect(args).toContain(`--overlay-src ${npmCache} --overlay /layer/0/upper /layer/0/work ${npmCache}`);
			expect(args).toContain(`--ro-bind ${cargo} ${cargo}`);
			expect(args).not.toContain(`--bind ${npmCache} ${npmCache}`);
			expect(args).not.toContain(`--bind ${cargo} ${cargo}`);
			const fallback = bwrapArgs(
				{ ...plan, cacheLayers: [{ path: cargo, source: "/private/cargo" }] },
				() => true,
				"/unreadable",
			).join(" ");
			expect(fallback).toContain(`--bind /private/cargo ${cargo}`);
			expect(fallback).toContain(`--ro-bind ${npmCache} ${npmCache}`);
		});
	});

	describe("layers", () => {
		it("makes a layer per command and removes it when released", () => {
			const root = join(agentDir, "sandbox", "layers");
			const caches = [join(home, ".npm"), join(home, ".cargo", "registry")];
			const first = cacheLayers(caches, { overlays: true, root, fallback: join(base, "fallback"), project });
			const second = cacheLayers(caches, { overlays: true, root, fallback: join(base, "fallback"), project });
			expect(first.layers.map(({ path }) => path)).toEqual(caches);
			expect(first.folders).toHaveLength(1);
			expect(second.folders[0]).not.toBe(first.folders[0]);
			for (const layer of first.layers) {
				if (!("upper" in layer)) throw new Error("expected an overlay");
				expect(existsSync(layer.upper) && existsSync(layer.work)).toBe(true);
			}
			first.release();
			second.release();
			expect(readdirSync(root)).toEqual([]);
		});

		it("removes the layers of a Prism process that has ended", () => {
			const root = join(agentDir, "sandbox", "layers");
			// A process id that cannot be running: above the kernel's limit.
			const orphan = join(root, "4194305-abc", "0", "upper");
			mkdirSync(orphan, { recursive: true });
			const mine = join(root, `${process.pid}-kept`);
			mkdirSync(mine);
			const made = cacheLayers([join(home, ".npm")], { overlays: true, root, fallback: join(base, "f"), project });
			expect(existsSync(join(root, "4194305-abc"))).toBe(false);
			expect(existsSync(mine)).toBe(true);
			made.release();
		});

		it("without overlays, gives each project its own private caches, kept", () => {
			const fallback = join(base, "fallback");
			const caches = [join(home, ".npm")];
			const options = { overlays: false, root: join(base, "layers"), fallback };
			const one = cacheLayers(caches, { ...options, project });
			const again = cacheLayers(caches, { ...options, project });
			const other = cacheLayers(caches, { ...options, project: join(home, "other") });
			const source = (made: typeof one) => {
				const [layer] = made.layers;
				if (!layer || !("source" in layer)) throw new Error("expected a private cache");
				return layer.source;
			};
			expect(source(again)).toBe(source(one));
			expect(source(other)).not.toBe(source(one));
			expect(source(one).startsWith(fallback)).toBe(true);
			one.release();
			expect(existsSync(source(one))).toBe(true);
		});

		it("says overlays do not work when bubblewrap cannot mount them", () => {
			const root = join(agentDir, "sandbox", "layers");
			expect(overlaysWork("/bin/false", [join(home, ".npm")], root)).toBe(false);
			expect(readdirSync(root)).toEqual([]);
		});
	});

	describe.skipIf(!bwrap)("in bubblewrap", () => {
		/** Runs `script` with the layout of the runtime, the caches shown through `overlays` or private caches. */
		function run(script: string, overlays: boolean): { status: number | null; stdout: string; stderr: string } {
			const plan = layout();
			prepareLayout(plan);
			const made = cacheLayers(plan.caches ?? [], {
				overlays,
				root: join(agentDir, "sandbox", "layers"),
				fallback: join(agentDir, "sandbox", "tool-caches"),
				project,
			});
			plan.cacheLayers = made.layers;
			const result = spawnSync(
				bwrap!,
				[...bwrapArgs(plan, isDirectory, join(base, "unreadable")), "--", "sh", "-ec", script],
				{ encoding: "utf8", timeout: 30_000 },
			);
			made.release();
			return result;
		}

		it.skipIf(!overlaysHere)("overlays work here", () => {
			const caches = [join(home, ".npm"), join(home, ".cargo", "registry")];
			expect(overlaysWork(bwrap!, caches, join(agentDir, "sandbox", "layers"))).toBe(true);
		});

		it.skipIf(!overlaysHere)("lets a command read the real cache and write over it, without changing it", () => {
			writeFileSync(join(home, ".npm", "kept"), "real\n");
			const result = run(
				`cat "$HOME/.npm/kept"; echo changed > "$HOME/.npm/kept"; echo new > "$HOME/.npm/added"; mkdir -p "$HOME/.cargo/registry/src/x"; cat "$HOME/.npm/kept"`,
				true,
			);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe("real\nchanged\n");
			expect(readFileSync(join(home, ".npm", "kept"), "utf8")).toBe("real\n");
			expect(existsSync(join(home, ".npm", "added"))).toBe(false);
			expect(existsSync(join(home, ".cargo", "registry", "src"))).toBe(false);
			expect(readdirSync(join(agentDir, "sandbox", "layers"))).toEqual([]);
		});

		it.skipIf(!overlaysHere)("removes a layer whose command deleted a folder of the real cache", () => {
			// overlayfs leaves entries in its work/work folder, mode 000, after such a deletion.
			mkdirSync(join(home, ".npm", "_cacache", "tmp"), { recursive: true });
			writeFileSync(join(home, ".npm", "_cacache", "tmp", "entry"), "real\n");
			const result = run(`rm -r "$HOME/.npm/_cacache"`, true);
			expect(result.status, result.stderr).toBe(0);
			expect(existsSync(join(home, ".npm", "_cacache", "tmp", "entry"))).toBe(true);
			expect(readdirSync(join(agentDir, "sandbox", "layers"))).toEqual([]);
		});

		it("without overlays, a command writes the project's private cache, never the real one", () => {
			writeFileSync(join(home, ".npm", "kept"), "real\n");
			const first = run(`test ! -e "$HOME/.npm/kept"; echo private > "$HOME/.npm/added"`, false);
			expect(first.status, first.stderr).toBe(0);
			expect(existsSync(join(home, ".npm", "added"))).toBe(false);
			// Kept for the project's next command.
			const second = run(`cat "$HOME/.npm/added"`, false);
			expect(second.stdout).toBe("private\n");
		});
	});

	describe.skipIf(!bwrap || !npm)("through Prism's runtime", () => {
		let tarball: string;

		/** The user, outside Prism and outside any sandbox. */
		const userNpx = () =>
			execFileSync("npx", ["--yes", `file:${tarball}`], {
				cwd: home,
				env: { ...process.env, npm_config_offline: "true", npm_config_update_notifier: "false" },
				encoding: "utf8",
				timeout: 60_000,
			}).trim();

		/** A local package, `audit-tool`, packed into `tarball`; broad mode. */
		function makeTool(): void {
			writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
			const source = join(base, "audit-tool");
			mkdirSync(source);
			writeFileSync(
				join(source, "package.json"),
				JSON.stringify({ name: "audit-tool", version: "1.0.0", bin: { "audit-tool": "index.js" } }),
			);
			writeFileSync(join(source, "index.js"), '#!/usr/bin/env node\nconsole.log("genuine tool");\n');
			chmodSync(join(source, "index.js"), 0o755);
			execFileSync("npm", ["pack", "--silent", "--pack-destination", base], {
				cwd: source,
				env: { ...process.env, npm_config_offline: "true", npm_config_update_notifier: "false" },
				timeout: 60_000,
			});
			tarball = join(base, "audit-tool-1.0.0.tgz");
		}

		/** Runs `command` through the bash tool, in the harness's project, after `setup` there. */
		async function bash(command: string, setup: (cwd: string) => void = () => {}): Promise<string> {
			harness = await createHarness({
				extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
			});
			setup(harness.tempDir);
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({
					select: async (_title, options) => options.find((option) => option.startsWith("Allow")),
				}),
			});
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command, timeout: 60 }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			const result = getToolResult(harness, "bash");
			const text = getMessageText(result);
			expect(result.isError, text).not.toBe(true);
			return text;
		}

		it("npx run by the user afterwards does not run what a sandboxed command wrote in ~/.npm/_npx", async () => {
			makeTool();
			expect(userNpx()).toBe("genuine tool");
			const marker = join(home, "ran-outside-the-sandbox");
			// What a hostile repository ships as its build script (the audit's probe).
			const script = [
				'f=$(find "$HOME/.npm/_npx" -name index.js -path "*audit-tool*" | head -1)',
				'test -n "$f"',
				`printf '%s\\n' '#!/usr/bin/env node' 'require("fs").writeFileSync(process.env.HOME + "/ran-outside-the-sandbox", "x");' 'console.log("genuine tool");' > "$f"`,
				'echo "rewritten: $f"',
				"",
			].join("\n");
			expect(await bash("sh ./build.sh", (cwd) => writeFileSync(join(cwd, "build.sh"), script))).toContain(
				"rewritten:",
			);
			expect(userNpx()).toBe("genuine tool");
			expect(existsSync(marker)).toBe(false);
			expect(readdirSync(join(agentDir, "sandbox", "layers"))).toEqual([]);
		}, 120_000);

		it("npx still works in the sandbox, from the user's cache, and leaves it unchanged", async () => {
			makeTool();
			const before = existsSync(join(home, ".npm", "_npx")) ? readdirSync(join(home, ".npm", "_npx")) : [];
			const output = await bash(
				`npm_config_offline=true npm_config_update_notifier=false npx --yes file:${tarball}`,
			);
			expect(output).toContain("genuine tool");
			const after = existsSync(join(home, ".npm", "_npx")) ? readdirSync(join(home, ".npm", "_npx")) : [];
			expect(after).toEqual(before);
			expect(readdirSync(join(agentDir, "sandbox", "layers"))).toEqual([]);
		}, 120_000);
	});
});
