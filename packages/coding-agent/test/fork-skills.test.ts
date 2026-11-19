// /skills over pi's own skill mechanism: list with provenance, on/off, install, remove.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { setViewsClient } from "../src/fork/interactive-client.ts";
import skillsExtension, { describeSkill, setSkillEnabled, skillOrigin } from "../src/fork/skills.ts";

const saved = { agentDir: process.env[ENV_AGENT_DIR], home: process.env.HOME };
const dirs: string[] = [];

afterEach(() => {
	setViewsClient();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of [
		[ENV_AGENT_DIR, saved.agentDir],
		["HOME", saved.home],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function writeSkill(dir: string, name: string, description: string): void {
	mkdirSync(join(dir, name), { recursive: true });
	writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nDo it.\n`);
}

/** A throwaway HOME, agent dir, project and local package with one skill each. */
function setup() {
	const root = mkdtempSync(join(tmpdir(), "prism-skills-"));
	dirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	const pkg = join(root, "pkg");
	process.env.HOME = join(root, "home");
	process.env[ENV_AGENT_DIR] = agentDir;
	writeSkill(join(agentDir, "skills"), "demo", "Global demo skill");
	writeSkill(join(pkg, "skills"), "pkgskill", "Skill from a package");
	mkdirSync(cwd, { recursive: true });
	const resolve = async () => {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resolved = await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve();
		return resolved.skills.map(describeSkill);
	};
	return { root, agentDir, cwd, pkg, resolve };
}

interface NativeSkillView {
	nativeMenu: {
		screenId: string;
		title: string;
		menuId: string;
		lines?: string[];
		items: { id: string; label: string; description?: string; statusText?: string }[];
	};
	handleNativeMenuInput(input: unknown): boolean;
}
type NativeFactory = (
	tui: undefined,
	theme: undefined,
	keys: undefined,
	done: (result: unknown) => void,
) => NativeSkillView;

function commandWith(
	answers: { select: string[]; input?: string[]; confirm?: boolean[] },
	cwd: string,
	native?: (view: NativeSkillView, close: () => void) => void,
) {
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	skillsExtension({
		registerCommand: (_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		},
		on: () => {},
	} as unknown as ExtensionAPI);
	const titles: string[] = [];
	const options: string[][] = [];
	const confirms: { title: string; message: string }[] = [];
	const notes: string[] = [];
	let reloads = 0;
	const ctx = {
		mode: "rpc",
		hasUI: true,
		cwd,
		isProjectTrusted: () => true,
		ui: {
			custom: (factory: NativeFactory) =>
				new Promise((resolve) => {
					const view = factory(undefined, undefined, undefined, resolve);
					native!(view, () => resolve(undefined));
				}),
			select: async (title: string, items: string[]) => {
				titles.push(title);
				options.push(items);
				return answers.select.shift();
			},
			input: async () => answers.input?.shift(),
			notify: (message: string) => void notes.push(message),
			confirm: async (title: string, message: string) => {
				confirms.push({ title, message });
				return answers.confirm?.shift() ?? true;
			},
		},
		reload: async () => void reloads++,
	} as unknown as ExtensionCommandContext;
	if (native) setViewsClient(true);
	return {
		run: () => handler?.("", ctx),
		titles,
		options,
		confirms,
		notes,
		reloads: () => reloads,
	};
}

describe("fork: /skills", () => {
	it("lists each skill with its name, description and where it comes from", async () => {
		const env = setup();
		const command = commandWith(
			{ select: ["Install a skill…", "All projects (global)", "Close"], input: [env.pkg] },
			env.cwd,
		);
		await command.run();
		const skills = await env.resolve();
		expect(skills.map((skill) => [skill.name, skill.description, skillOrigin(skill.resource)])).toEqual([
			["demo", "Global demo skill", "all projects, folder"],
			["pkgskill", "Skill from a package", "all projects, package ../pkg"],
		]);
		expect(command.options[0]).toEqual(["demo — on — all projects, folder", "Install a skill…", "Close"]);
		expect(command.options.at(-1)).toContain("pkgskill — on — all projects, package ../pkg");
		expect(command.confirms[0]?.title).toBe("Install this skill package?");
		expect(command.confirms[0]?.message).toContain(`Source: ${env.pkg}\nFor: all projects`);
		expect(command.reloads()).toBe(1);
	});

	// third-party code may run, so the user confirms the source and scope.
	it("asks before installing a package, with its source, where it applies and a warning, and installs nothing when refused", async () => {
		const env = setup();
		const command = commandWith(
			{ select: ["Install a skill…", "This project only", "Close"], input: [env.pkg], confirm: [false] },
			env.cwd,
		);
		await command.run();
		expect(command.confirms).toHaveLength(1);
		expect(command.confirms[0]?.message).toContain(`Source: ${env.pkg}\nFor: this project`);
		expect(command.confirms[0]?.message).toContain("A package can run extension code on your machine");
		expect(command.notes).toEqual(["Nothing was installed."]);
		expect(existsSync(join(env.cwd, ".pi", "settings.json"))).toBe(false);
		expect((await env.resolve()).map((skill) => skill.name)).toEqual(["demo"]);
		expect(command.reloads()).toBe(0);
	});

	it.each(["All projects (global)", "This project only"])(
		"finds skills after a relative install for %s",
		async (scope) => {
			const env = setup();
			writeSkill(join(env.cwd, "fixture-package/skills"), "relative-skill", "Relative package");
			const command = commandWith(
				{ select: ["Install a skill…", scope, "Close"], input: ["./fixture-package"] },
				env.cwd,
			);
			await command.run();
			expect(command.confirms).toHaveLength(1);
			expect(command.notes.at(-1)).toBe("Installed ./fixture-package.");
			expect((await env.resolve()).map((skill) => skill.name)).toContain("relative-skill");
		},
	);

	// fork.9 QA: git:github.com/badlogic/pi-skills keeps its skills at the root, which pi does not discover; the package
	// was then listed nowhere in /skills and could not be removed from there.
	it("says when an installed package brings no skill, and removes it on request", async () => {
		const env = setup();
		const empty = join(env.root, "empty");
		writeSkill(empty, "rootskill", "Skill outside the skills folder");
		const removed = commandWith(
			{ select: ["Install a skill…", "All projects (global)", "Close"], input: [empty], confirm: [true, true] },
			env.cwd,
		);
		await removed.run();
		expect(removed.confirms[1]?.title).toBe("This package brings no skill");
		expect(removed.confirms[1]?.message).toContain(`${empty} is installed, but Prism found no skill in it`);
		expect(removed.notes.at(-1)).toBe(`Removed ${empty}.`);
		expect(JSON.parse(readFileSync(join(env.agentDir, "settings.json"), "utf8")).packages).toEqual([]);

		const kept = commandWith(
			{ select: ["Install a skill…", "All projects (global)", "Close"], input: [empty], confirm: [true, false] },
			env.cwd,
		);
		await kept.run();
		expect(kept.notes.at(-1)).toBe(`Installed ${empty}, without skills.`);
		expect(JSON.parse(readFileSync(join(env.agentDir, "settings.json"), "utf8")).packages).toEqual(["../empty"]);

		const full = commandWith(
			{ select: ["Install a skill…", "All projects (global)", "Close"], input: [env.pkg] },
			env.cwd,
		);
		await full.run();
		expect(full.confirms).toHaveLength(1);
		expect(full.notes.at(-1)).toBe(`Installed ${env.pkg}.`);
	});

	it("asks before updating packages, listing each with where it applies, and updates nothing when refused", async () => {
		const env = setup();
		writeFileSync(join(env.agentDir, "settings.json"), JSON.stringify({ packages: ["../pkg"] }));
		const refused = commandWith({ select: ["Update skill packages", "Close"], confirm: [false] }, env.cwd);
		await refused.run();
		expect(refused.confirms[0]?.title).toBe("Update these skill packages?");
		expect(refused.confirms[0]?.message).toContain("../pkg — all projects");
		expect(refused.confirms[0]?.message).toContain("Install or update only a source you have reviewed and trust.");
		expect(refused.notes).toEqual(["Nothing was updated."]);
		expect(refused.reloads()).toBe(0);
		const accepted = commandWith({ select: ["Update skill packages", "Close"], confirm: [true] }, env.cwd);
		await accepted.run();
		expect(accepted.notes).toEqual(["Skill packages are up to date."]);
		expect(accepted.reloads()).toBe(1);
	});

	// fork: a failed update is never followed by "up to date".
	it("does not say packages are up to date when an update failed", async () => {
		const env = setup();
		writeFileSync(join(env.agentDir, "settings.json"), JSON.stringify({ packages: ["../pkg"] }));
		const update = vi.spyOn(DefaultPackageManager.prototype, "update").mockRejectedValueOnce(new Error("offline"));
		try {
			const failed = commandWith({ select: ["Update skill packages", "Close"], confirm: [true] }, env.cwd);
			await failed.run();
			expect(failed.notes).toEqual(["offline", "Some skill packages were not updated."]);
			expect(failed.reloads()).toBe(0);
		} finally {
			update.mockRestore();
		}
	});

	// fork: the project copy hides the global one; updating it leaves the global.
	it("updates only the scope it shows when a package is installed globally and for the project", async () => {
		const env = setup();
		writeFileSync(join(env.agentDir, "settings.json"), JSON.stringify({ packages: [env.pkg] }));
		mkdirSync(join(env.cwd, ".pi"), { recursive: true });
		writeFileSync(join(env.cwd, ".pi", "settings.json"), JSON.stringify({ packages: [env.pkg] }));
		const update = vi.spyOn(DefaultPackageManager.prototype, "update").mockResolvedValue(undefined);
		try {
			const command = commandWith({ select: ["Update skill packages", "Close"], confirm: [true] }, env.cwd);
			await command.run();
			expect(command.confirms[0]?.message).toContain(`${env.pkg} — this project`);
			expect(command.confirms[0]?.message).not.toContain(`${env.pkg} — all projects`);
			expect(update.mock.calls).toEqual([[env.pkg, { local: true }]]);
		} finally {
			update.mockRestore();
		}
	});

	it("turns a folder skill and a package skill off and on, as prism config does", async () => {
		const env = setup();
		writeFileSync(join(env.agentDir, "settings.json"), JSON.stringify({ packages: ["../pkg"] }));
		const settings = SettingsManager.create(env.cwd, env.agentDir);
		for (const skill of await env.resolve()) setSkillEnabled(settings, skill.resource, false, env.agentDir, env.cwd);
		await settings.flush();
		const saved = JSON.parse(readFileSync(join(env.agentDir, "settings.json"), "utf8"));
		expect(saved.skills).toEqual(["-skills/demo/SKILL.md"]);
		expect(saved.packages).toEqual([{ source: "../pkg", skills: ["-skills/pkgskill/SKILL.md"] }]);
		expect((await env.resolve()).map((skill) => skill.resource.enabled)).toEqual([false, false]);

		const again = SettingsManager.create(env.cwd, env.agentDir);
		for (const skill of await env.resolve()) setSkillEnabled(again, skill.resource, true, env.agentDir, env.cwd);
		await again.flush();
		expect((await env.resolve()).map((skill) => skill.resource.enabled)).toEqual([true, true]);
	});

	it("turns a skill off from the screen and reloads once when it closes", async () => {
		const env = setup();
		const command = commandWith({ select: ["demo — on — all projects, folder", "Turn it off", "Close"] }, env.cwd);
		await command.run();
		expect(command.titles[1]).toContain("Global demo skill");
		expect(command.options[2]?.[0]).toBe("demo — off — all projects, folder");
		expect((await env.resolve())[0]?.resource.enabled).toBe(false);
		expect(command.reloads()).toBe(1);
	});

	it("removes a skill package after confirmation, and changes nothing when only looking", async () => {
		const env = setup();
		writeFileSync(join(env.agentDir, "settings.json"), JSON.stringify({ packages: ["../pkg"] }));
		const looking = commandWith({ select: ["Close"] }, env.cwd);
		await looking.run();
		expect(looking.reloads()).toBe(0);
		const command = commandWith(
			{ select: ["pkgskill — on — all projects, package ../pkg", "Remove its package", "Close"] },
			env.cwd,
		);
		await command.run();
		expect(JSON.parse(readFileSync(join(env.agentDir, "settings.json"), "utf8")).packages).toEqual([]);
		expect((await env.resolve()).map((skill) => skill.name)).toEqual(["demo"]);
		// A local package is only forgotten: its folder stays.
		expect(readFileSync(join(env.pkg, "skills", "pkgskill", "SKILL.md"), "utf8")).toContain("pkgskill");
		expect(command.reloads()).toBe(1);
	});

	it("uses structured native entries and retains the same toggle and reload", async () => {
		const env = setup();
		let step = 0;
		let menuId = "";
		const command = commandWith({ select: [] }, env.cwd, (view) => {
			for (const invalid of [
				null,
				{},
				{ kind: "setting", itemId: "skill:0", value: false },
				{ kind: "activate", itemId: "missing" },
			])
				expect(view.handleNativeMenuInput(invalid)).toBe(false);
			if (step++ === 0) {
				menuId = view.nativeMenu.menuId;
				expect(view.nativeMenu.items[0]).toMatchObject({
					id: "skill:0",
					label: "demo",
					description: "Global demo skill\nall projects, folder",
					statusText: "on",
				});
				view.handleNativeMenuInput({ kind: "activate", itemId: "skill:0" });
			} else if (step === 2) {
				expect(view.nativeMenu.lines).toContain(join(env.agentDir, "skills/demo/SKILL.md"));
				expect(view.nativeMenu.items).toEqual([{ id: "toggle", label: "Turn it off" }]);
				view.handleNativeMenuInput({ kind: "activate", itemId: "toggle" });
			} else {
				expect(view.nativeMenu.menuId).toBe(menuId);
				expect(view.nativeMenu.items[0]?.statusText).toBe("off");
				view.handleNativeMenuInput({ kind: "back" });
			}
		});
		await command.run();
		expect(step).toBe(3);
		expect((await env.resolve())[0]?.resource.enabled).toBe(false);
		expect(command.reloads()).toBe(1);
		expect(command.options).toEqual([]);
	});

	it("closes a nested native screen without reopening its parent or changing settings", async () => {
		const env = setup();
		let shown = 0;
		const command = commandWith({ select: [] }, env.cwd, (view, close) => {
			if (++shown === 1) view.handleNativeMenuInput({ kind: "activate", itemId: "skill:0" });
			else close();
		});
		await command.run();
		expect(shown).toBe(2);
		expect(command.reloads()).toBe(0);
		expect(existsSync(join(env.agentDir, "settings.json"))).toBe(false);
	});

	it("selects the right resource when two native entries have the same label", async () => {
		const env = setup();
		writeSkill(join(env.agentDir, "skills"), "another", "Second folder");
		writeFileSync(
			join(env.agentDir, "skills/another/SKILL.md"),
			"---\nname: demo\ndescription: Second folder\n---\nDo it.\n",
		);
		let selectedPath = "";
		const inputs = ["skill:1", "toggle", undefined];
		const command = commandWith({ select: [] }, env.cwd, (view, close) => {
			const itemId = inputs.shift();
			if (view.nativeMenu.screenId.startsWith("skill:")) selectedPath = view.nativeMenu.lines!.at(-1)!;
			if (itemId) view.handleNativeMenuInput({ kind: "activate", itemId });
			else close();
		});
		await command.run();
		const skills = await env.resolve();
		expect(skills.map((skill) => skill.name)).toEqual(["demo", "demo"]);
		expect(skills.find((skill) => skill.resource.path === selectedPath)?.resource.enabled).toBe(false);
		expect(skills.find((skill) => skill.resource.path !== selectedPath)?.resource.enabled).toBe(true);
	});

	it("keeps native install confirmation, source and scope; then removes the whole local package", async () => {
		const env = setup();
		const inputs = ["install", "skill:1", "remove", undefined];
		const command = commandWith({ select: ["All projects (global)"], input: [env.pkg] }, env.cwd, (view, close) => {
			const itemId = inputs.shift();
			if (itemId) expect(view.handleNativeMenuInput({ kind: "activate", itemId })).toBe(true);
			else close();
		});
		await command.run();
		expect(inputs).toEqual([]);
		expect(command.confirms[0]?.message).toContain(`Source: ${env.pkg}\nFor: all projects`);
		expect(command.confirms[0]?.message).toContain("A package can run extension code");
		expect(command.confirms[1]?.message).toContain("This removes ../pkg and every skill it brings.");
		expect(JSON.parse(readFileSync(join(env.agentDir, "settings.json"), "utf8")).packages).toEqual([]);
		expect(existsSync(join(env.pkg, "skills/pkgskill/SKILL.md"))).toBe(true);
		expect(command.reloads()).toBe(1);
	});

	it("leaves packages unchanged after native install or update is refused", async () => {
		const env = setup();
		writeFileSync(join(env.agentDir, "settings.json"), JSON.stringify({ packages: ["../pkg"] }));
		const inputs = ["install", "update", undefined];
		const command = commandWith(
			{ select: ["This project only"], input: [env.pkg], confirm: [false, false] },
			env.cwd,
			(view, close) => {
				const itemId = inputs.shift();
				if (itemId) view.handleNativeMenuInput({ kind: "activate", itemId });
				else close();
			},
		);
		await command.run();
		expect(command.confirms[0]?.message).toContain("For: this project");
		expect(command.confirms[1]?.message).toContain("../pkg — all projects");
		expect(command.notes).toEqual(["Nothing was installed.", "Nothing was updated."]);
		expect(command.reloads()).toBe(0);
		expect(existsSync(join(env.cwd, ".pi/settings.json"))).toBe(false);
	});
});
