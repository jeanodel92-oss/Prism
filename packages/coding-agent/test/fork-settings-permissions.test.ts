// fork: the Permissions & sandbox domain of /settings: the modes, the
// saved rules and protected paths edited as lists with their scope, the sandbox's settings saved and applied,
// and /perm, /perm window and /sandbox opening the right place.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import type { HostGrant } from "../src/fork/project-permissions.ts";
import { DEFAULT_SANDBOX_SETTINGS, type SandboxSettings } from "../src/fork/sandbox/layout.ts";
import { groupSettingsByDomain } from "../src/fork/settings-domains.ts";
import { ListEditor } from "../src/fork/settings-list-editor.ts";
import {
	type PermissionList,
	type PermissionScope,
	type PermissionSettingsDeps,
	permissionsSection,
} from "../src/fork/settings-permissions.ts";
import { setSettingsHost, settingsSections } from "../src/fork/settings-sections.ts";
import { ValueInput } from "../src/fork/settings-value-input.ts";
import { SettingsView } from "../src/fork/settings-view.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;:]*m|\x1b_[^\x07]*\x07/g, "");
async function input(view: { handleInput?(data: string): void }, data: string): Promise<void> {
	view.handleInput?.(data);
	await new Promise<void>((resolve) => setImmediate(resolve));
}
const ENTER = "\r";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ESC = "\x1b";

function fakeDeps(trusted = true, broken = false) {
	const files: Record<PermissionScope, Partial<Record<PermissionList, string[]>>> = {
		global: { allow: ["read"], deny: ["bash(rm -rf*)"] },
		project: { allow: ["bash(npm run test*)"] },
	};
	let sandbox: SandboxSettings = structuredClone(DEFAULT_SANDBOX_SETTINGS);
	const project: { allow: string[]; hosts: HostGrant[] } = { allow: [], hosts: [] };
	let failWrites = false;
	const deps = {
		mode: () => "ask" as const,
		modes: () => ["safe", "ask", "broad"] as const,
		setMode: vi.fn(),
		defaultMode: () => "ask" as const,
		setDefaultMode: vi.fn(),
		projectTrusted: () => trusted,
		readList: (scope: PermissionScope, list: PermissionList) => files[scope][list] ?? [],
		changeList: vi.fn((scope: PermissionScope, list: PermissionList, change: (current: string[]) => string[]) => {
			if (failWrites) throw new Error("permissions.json is not a valid permissions file.");
			files[scope][list] = change(files[scope][list] ?? []);
		}),
		parseRule: (text: string) => (/^\w+(\(.*\))?$/.test(text) ? text : new Error("Type a rule: tool or tool(glob).")),
		projectGrants: () => [
			...project.allow.map((rule) => ({ id: `allow ${rule}`, label: `Run ${rule}`, detail: rule })),
			...project.hosts.map(({ host, rule }) => ({
				id: `host ${host} ${rule}`,
				label: `Let ${rule} connect to ${host}`,
				detail: rule,
			})),
		],
		addProjectRule: vi.fn((rule: string) => {
			project.allow.push(rule);
		}),
		removeProjectGrant: vi.fn((id: string) => {
			project.allow = project.allow.filter((rule) => id !== `allow ${rule}`);
			project.hosts = project.hosts.filter(({ host, rule }) => id !== `host ${host} ${rule}`);
		}),
		defaultProtectedPaths: ["**/.env", "**/*.pem"],
		readTools: () => [
			{ name: "Git", paths: ["~/.gitconfig"] },
			{ name: "Rust", paths: ["~/.rustup", "~/.cargo"] },
		],
		parseReadable: (text: string) =>
			text.includes(".ssh") ? new Error("~/.ssh cannot be opened here.") : text.replace(/^~/, "/home/u"),
		shortPath: (path: string) => path.replace(/^\/home\/u/, "~"),
		sandbox: () => sandbox,
		saveSandbox: vi.fn((path: readonly string[], value: unknown) => {
			if (failWrites) throw new Error("settings.json is locked.");
			// settings.json keeps read.tools.<name>: false; the settings read back list it in read.toolsOff.
			if (path[0] === "read" && path[1] === "tools") {
				const off = sandbox.read.toolsOff.filter((tool) => tool !== path[2]);
				sandbox = { ...sandbox, read: { ...sandbox.read, toolsOff: value === false ? [...off, path[2]!] : off } };
				return;
			}
			const next = structuredClone(sandbox) as unknown as Record<string, unknown>;
			let at = next;
			for (const key of path.slice(0, -1)) at = at[key] as Record<string, unknown>;
			at[path[path.length - 1]!] = value;
			sandbox = next as unknown as SandboxSettings;
		}),
		sandboxState: () =>
			broken
				? { label: "not working", lines: ["Sandbox: broken: bubblewrap failed."], broken }
				: { label: "on in this mode", lines: ["Sandbox: on in ask mode."], broken },
		checkSandbox: vi.fn(),
		report: vi.fn(),
	} satisfies PermissionSettingsDeps;
	return {
		deps,
		files,
		project,
		failWrites: (fail: boolean) => {
			failWrites = fail;
		},
	};
}

describe("fork: Permissions & sandbox in /settings", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		setLanguage("en");
		setSettingsHost(undefined);
	});

	const build = (deps: PermissionSettingsDeps, advanced = true) =>
		groupSettingsByDomain([], vi.fn(), {
			builtinExtensions: [],
			onBuiltinExtensionChange: vi.fn(),
			interfaceMode: advanced ? "advanced" : "simple",
			sections: () => [permissionsSection(deps)],
		});
	const domainItems = (deps: PermissionSettingsDeps, advanced = true) =>
		build(deps, advanced)
			.domains()
			.find((d) => d.id === "permissions")!
			.items();

	it("shows the modes, the rules of both scopes and the sandbox, the long lists only in the advanced interface", () => {
		const { deps } = fakeDeps();
		const items = domainItems(deps);
		const value = (id: string) => items.find((item) => item.id === id)?.currentValue;
		expect(value("perm-mode")).toBe("ask");
		expect(value("perm-rules")).toBe("allow 2 · deny 1");
		expect(value("perm-protected")).toBe("**/.env, **/*.pem");
		expect(value("sandbox-state")).toBe("on in this mode");
		expect(value("sandbox-modes")).toBe("safe, ask, broad");
		expect(value("sandbox-ask-hosts")).toBe("on");
		expect(items.find((item) => item.id === "perm-mode")?.values).toEqual(["safe", "ask", "broad"]);
		const simple = domainItems(deps, false).map((item) => item.id);
		expect(simple).not.toContain("sandbox-write");
		expect(simple).not.toContain("perm-protected");
		// the simple interface keeps what a beginner needs.
		expect(simple).toEqual([
			"perm-mode",
			"perm-default-mode",
			"command:perm window",
			"command:perm scope",
			"perm-project",
			"sandbox-state",
			"sandbox-read-limit",
		]);
		setLanguage("fr");
		const fr = domainItems(deps);
		expect(fr.find((item) => item.id === "perm-rules")).toMatchObject({
			label: "Règles",
			currentValue: "autoriser 2 · bloquer 1",
		});
		expect(fr.find((item) => item.id === "sandbox-modes")?.currentValue).toBe("prudent, demander, large");
		// The settings of « Outils courants avec la sandbox » are translated too.
		for (const [id, label] of [
			["sandbox-git-signing", "Git signe avec ma clé"],
			["sandbox-containers", "Les commandes voient mes conteneurs"],
			["sandbox-service-state", "Les commandes lisent l'état des services"],
		]) {
			const item = fr.find((i) => i.id === id)!;
			expect(item.label).toBe(label);
			expect(item.description).toMatch(/^Laisser /);
		}
	});

	// a broken sandbox is fixed from the interface, without restarting Prism.
	it("offers to check a broken sandbox again, and only then", async () => {
		expect(domainItems(fakeDeps().deps).map((item) => item.id)).not.toContain("sandbox-check");
		const { deps } = fakeDeps(true, true);
		const settings = build(deps);
		const check = settings
			.domains()
			.find((d) => d.id === "permissions")!
			.items()
			.find((item) => item.id === "sandbox-check");
		expect(check?.label).toBe("Check the sandbox again");
		await settings.onChange("sandbox-check", "check");
		expect(deps.checkSandbox).toHaveBeenCalledTimes(1);
	});

	it("an untrusted project's rules are neither shown nor asked for", () => {
		const { deps } = fakeDeps(false);
		expect(domainItems(deps).find((item) => item.id === "perm-rules")?.currentValue).toBe("allow 1 · deny 1");
	});

	it("waits for an asynchronous value save and refuses duplicate submissions", async () => {
		let finish!: () => void;
		const saving = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const save = vi.fn(() => saving);
		const done = vi.fn();
		const view = new ValueInput({
			title: "Value",
			description: "",
			current: "",
			parse: (text) => text,
			save,
			done,
			requestRender: vi.fn(),
		});
		await input(view, "value");
		await input(view, ENTER);
		await input(view, ENTER);
		expect(save).toHaveBeenCalledTimes(1);
		expect(done).not.toHaveBeenCalled();
		finish();
		await vi.waitFor(() => expect(done).toHaveBeenCalledWith(true));
	});

	it("shows an asynchronous list save error and keeps the list open", async () => {
		let fail!: (error: Error) => void;
		const saving = new Promise<void>((_resolve, reject) => {
			fail = reject;
		});
		const save = vi.fn(() => saving);
		const done = vi.fn();
		const list = new ListEditor({
			title: "Rules",
			description: "",
			addPrompt: "Rule",
			entries: () => [],
			onAdd: save,
			onRemove: vi.fn(),
			done,
			requestRender: vi.fn(),
		});
		await input(list, ENTER);
		await input(list, "read");
		await input(list, ENTER);
		await input(list, ENTER);
		expect(save).toHaveBeenCalledTimes(1);
		fail(new Error("Lock file is already being held"));
		await vi.waitFor(() =>
			expect(list.render(64).map(plain).join("\n")).toContain("Lock file is already being held"),
		);
		expect(done).not.toHaveBeenCalled();
		await input(list, ESC);
		expect(done).toHaveBeenCalledWith(false);
	});

	it("adds a rule with its effect and scope, refuses a wrong one, removes one after a second Enter", async () => {
		const { deps, files } = fakeDeps();
		const view = new SettingsView(build(deps), { onClose: vi.fn(), rows: () => 50 });
		for (const key of "/rules") await input(view, key);
		await input(view, DOWN);
		await input(view, ENTER);
		// The right pane of the overlay, without its frame.
		const lines = () => view.render(100).map((l) => (plain(l).split("│")[2] ?? "").slice(1));
		expect(lines().some((l) => /^ {2}bash\(npm run test\*\) +allow · project/.test(l))).toBe(true);
		await input(view, ENTER);
		for (const key of "bash(oops") await input(view, key);
		await input(view, ENTER);
		expect(lines().join("\n")).toContain("Type a rule: tool or tool(glob).");
		for (const key of ")") await input(view, key);
		await input(view, ENTER);
		expect(lines().join("\n")).toContain("bash(oops) · What it does");
		await input(view, DOWN);
		await input(view, DOWN);
		await input(view, ENTER);
		expect(lines().join("\n")).toContain("bash(oops) · Where to save it");
		await input(view, ENTER);
		expect(files.project.deny).toEqual(["bash(oops)"]);
		// The cursor is on the new rule: Enter asks, a second Enter removes it.
		expect(lines().some((l) => l.startsWith("→ bash(oops)"))).toBe(true);
		await input(view, ENTER);
		expect(lines().join("\n")).toContain("Enter again removes it, Esc keeps it");
		await input(view, ENTER);
		expect(files.project.deny).toEqual([]);
		await input(view, ESC);
		expect(lines().some((l) => /Rules +allow 2 · deny 1/.test(l))).toBe(true);
	});

	it("keeps Prism's protected paths and shows a failed write in the list", async () => {
		const { deps, files, failWrites } = fakeDeps(false);
		const done = vi.fn();
		const item = domainItems(deps).find((i) => i.id === "perm-protected")!;
		const list = item.submenu!(item.currentValue, done) as ListEditor;
		expect(list).toBeInstanceOf(ListEditor);
		const lines = () => list.render(80).map(plain);
		// « Add… » then Prism's two paths.
		await input(list, DOWN);
		await input(list, ENTER);
		expect(lines().join("\n")).toContain("Prism always applies this one; it cannot be removed here.");
		await input(list, DOWN);
		await input(list, DOWN);
		await input(list, ENTER);
		for (const key of "secrets/**") await input(list, key);
		await input(list, ENTER);
		// Untrusted project: no scope to choose, saved globally.
		expect(files.global.protectedPaths).toEqual(["secrets/**"]);
		expect(lines().some((l) => /^→ secrets\/\*\* +global/.test(l))).toBe(true);
		failWrites(true);
		await input(list, ENTER);
		await input(list, ENTER);
		expect(lines().join("\n")).toContain("permissions.json is not a valid permissions file.");
		expect(files.global.protectedPaths).toEqual(["secrets/**"]);
		await input(list, ESC);
		expect(done).toHaveBeenCalledWith("changed");
	});

	it("lists what was allowed for this project in words and takes one back", async () => {
		const { deps, project } = fakeDeps();
		project.allow.push("bash(npm install*)");
		project.hosts.push({ host: "registry.npmjs.org", rule: "bash(npm install*)" });
		const done = vi.fn();
		const item = domainItems(deps).find((i) => i.id === "perm-project")!;
		expect(item.currentValue).toContain("Run bash(npm install*)");
		const list = item.submenu!(item.currentValue, done) as ListEditor;
		const lines = () => list.render(80).map(plain);
		expect(
			lines().some((l) =>
				/Let bash\(npm install\*\) connect to registry\.npmjs\.org +bash\(npm install\*\)/.test(l),
			),
		).toBe(true);
		// « Add… », the rule, then the host: a second Enter takes it back.
		await input(list, DOWN);
		await input(list, DOWN);
		await input(list, ENTER);
		await input(list, ENTER);
		expect(deps.removeProjectGrant).toHaveBeenCalledWith("host registry.npmjs.org bash(npm install*)");
		expect(project.hosts).toEqual([]);
		expect(project.allow).toEqual(["bash(npm install*)"]);
	});

	it("saves the sandbox's settings changed in place or in a list, and reports a failure", async () => {
		const { deps, failWrites } = fakeDeps();
		const section = permissionsSection(deps);
		await section.onChange!("sandbox-ask-hosts", "off");
		expect(deps.saveSandbox).toHaveBeenLastCalledWith(["network", "askNewHosts"], false);
		// The system D-Bus setting is gone: it opened every Unix socket of the machine.
		expect(section.items({ advanced: () => true, requestRender: vi.fn() }).map((i) => i.id)).not.toContain(
			"sandbox-bus",
		);
		const context = { advanced: () => true, requestRender: vi.fn() };
		const hosts = section.items(context).find((i) => i.id === "sandbox-allow-hosts")!;
		const list = hosts.submenu!(hosts.currentValue, vi.fn()) as ListEditor;
		await input(list, ENTER);
		for (const key of "registry.npmjs.org") await input(list, key);
		await input(list, ENTER);
		expect(deps.sandbox().network.allow).toContain("registry.npmjs.org");
		const modes = section.items(context).find((i) => i.id === "sandbox-modes")!;
		const submenu = modes.submenu!(modes.currentValue, vi.fn());
		await input(submenu, ENTER);
		expect(deps.sandbox().modes.safe).toBe(false);
		failWrites(true);
		await section.onChange!("sandbox-user-commands", "on");
		expect(deps.report).toHaveBeenCalledWith("settings.json is locked.");
		await section.onChange!("perm-default-mode", "safe");
		expect(deps.setDefaultMode).toHaveBeenCalledWith("safe");
		await section.onChange!("perm-mode", "unrestricted");
		expect(deps.setMode).not.toHaveBeenCalled();
		await section.onChange!("perm-mode", "broad");
		expect(deps.setMode).toHaveBeenCalledWith("broad");
	});

	// fork: Readable files.
	it("limits reading from here, by default, and then lists the tools' resources and what else is readable", async () => {
		const { deps, project } = fakeDeps();
		const context = { advanced: () => false, requestRender: vi.fn() };
		const section = permissionsSection(deps);
		const ids = () => section.items(context).map((item) => item.id);
		const item = (id: string) => section.items(context).find((i) => i.id === id)!;
		expect(item("sandbox-read-limit")).toMatchObject({ currentValue: "project", values: ["project", "all"] });
		expect(item("sandbox-read-limit").description).toContain("MCP and LSP servers and your browser are not limited");
		await section.onChange!("sandbox-read-limit", "all");
		expect(deps.saveSandbox).toHaveBeenLastCalledWith(["read", "limit"], "all");
		expect(ids()).not.toContain("sandbox-read-tools");
		expect(ids()).not.toContain("sandbox-read-allow");
		await section.onChange!("sandbox-read-limit", "project");
		expect(deps.saveSandbox).toHaveBeenLastCalledWith(["read", "limit"], "project");
		expect(ids()).toEqual(expect.arrayContaining(["sandbox-read-tools", "sandbox-read-allow"]));

		// One line per tool found; turning one off is saved.
		expect(item("sandbox-read-tools").currentValue).toBe("Git, Rust");
		const tools = item("sandbox-read-tools").submenu!("", vi.fn());
		const toolLines = () => tools.render(100).map(plain).join("\n");
		expect(toolLines()).toContain("Rust");
		await input(tools, DOWN);
		await input(tools, ENTER);
		expect(deps.saveSandbox).toHaveBeenLastCalledWith(["read", "tools", "Rust"], false);
		expect(item("sandbox-read-tools").currentValue).toBe("Git");

		// Also readable: for this project in its grants, for every project in settings.json; hidden paths refused.
		let list = item("sandbox-read-allow").submenu!("", vi.fn()) as ListEditor;
		const lines = () => list.render(100).map(plain).join("\n");
		const add = async (text: string, down: number) => {
			await input(list, ENTER);
			for (const key of text) await input(list, key);
			await input(list, ENTER);
			for (let i = 0; i < down; i++) await input(list, DOWN);
			await input(list, ENTER);
		};
		await input(list, ENTER);
		for (const key of "~/.ssh") await input(list, key);
		await input(list, ENTER);
		expect(lines()).toContain("~/.ssh cannot be opened here.");
		await input(list, ESC);
		await input(list, UP);
		await add("~/Documents/specs", 0);
		expect(project.allow).toEqual(["readable(/home/u/Documents/specs)"]);
		// Opened again, as after Esc: the cursor is on « Add… ».
		list = item("sandbox-read-allow").submenu!("", vi.fn()) as ListEditor;
		await add("~/notes", 1);
		expect(deps.sandbox().read.allow).toEqual(["~/notes"]);
		expect(lines()).toMatch(/~\/notes +every project/);
		expect(lines()).toMatch(/~\/Documents\/specs +this project/);
		expect(item("sandbox-read-allow").currentValue).toBe("~/notes, ~/Documents/specs");
	});
});

describe("fork: /perm and /sandbox open /settings", () => {
	let agentDir: string;
	let harness: Harness | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-settings-perm-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		setSettingsHost(undefined);
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function start() {
		const custom = vi.fn(async () => undefined as never);
		harness = await createHarness({ extensionFactories: [{ name: "permissions", factory: permissionsExtension }] });
		const notices: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notices.push(message), custom }),
		});
		return { harness, notices, custom };
	}

	it("registers the domain while the session runs and opens it from /perm and /sandbox", async () => {
		const { harness, custom } = await start();
		const section = settingsSections().find((s) => s.domain === "permissions");
		expect(section).toBeDefined();
		const host = vi.fn();
		setSettingsHost(host);
		await harness.session.prompt("/perm");
		expect(host).toHaveBeenLastCalledWith({ domain: "permissions" });
		await harness.session.prompt("/sandbox");
		expect(host).toHaveBeenLastCalledWith({ domain: "permissions", item: "sandbox-state" });
		expect(custom).not.toHaveBeenCalled();
		// /perm window opens the modes and the permissions in effect, as /perm did.
		await harness.session.prompt("/perm window");
		expect(custom).toHaveBeenCalled();
		await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		expect(settingsSections()).not.toContain(section);
	});

	it("saves a rule in permissions.json, refuses to replace an invalid one, saves the sandbox in settings.json", async () => {
		const { notices } = await start();
		const section = settingsSections().find((s) => s.domain === "permissions")!;
		const context = { advanced: () => true, requestRender: vi.fn() };
		const rules = section.items(context).find((i) => i.id === "perm-rules")!;
		const list = rules.submenu!(rules.currentValue, vi.fn()) as ListEditor;
		// Allow, then every project.
		const add = async (rule: string) => {
			await input(list, ENTER);
			for (const key of rule) await input(list, key);
			await input(list, ENTER);
			await input(list, ENTER);
			await input(list, DOWN);
			await input(list, ENTER);
		};
		await add("bash(make*)");
		const file = join(agentDir, "permissions.json");
		expect(JSON.parse(readFileSync(file, "utf8")).allow).toEqual(["bash(make*)"]);
		writeFileSync(file, "{ not json");
		await input(list, UP);
		await add("read");
		const shown = list
			.render(100)
			.map((l) => plain(l).trim())
			.join(" ");
		// fork: the refusal names the cause.
		expect(shown).toMatch(
			/permissions\.json is not a valid permissions file \(it is not valid JSON.*\)\. Fix it, then retry\./,
		);
		expect(readFileSync(file, "utf8")).toBe("{ not json");
		// The sandbox's page: /sandbox's lines, closed with Esc rather than a « Close » choice.
		const state = section.items(context).find((i) => i.id === "sandbox-state")!;
		const page = state.submenu!(state.currentValue, vi.fn())
			.render(100)
			.map((l) => plain(l).trim());
		// No mode configured: the session starts in broad.
		expect(page).toContain("Sandbox: on (broad mode)");
		expect(page).not.toContain("Close");
		await section.onChange!("sandbox-user-commands", "on");
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		expect(settings.sandbox).toEqual({ userCommands: true });
		expect(notices.filter((n) => n.includes("does not work"))).toEqual([]);
	});

	it("keeps another session's domain when an older session shuts down", async () => {
		const first = await start();
		const own = settingsSections().find((s) => s.domain === "permissions");
		const firstHarness = first.harness;
		harness = undefined;
		const second = await start();
		const replaced = settingsSections().find((s) => s.domain === "permissions");
		expect(replaced).not.toBe(own);
		await firstHarness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		expect(settingsSections()).toContain(replaced);
		firstHarness.cleanup();
		harness = second.harness;
	});
});
