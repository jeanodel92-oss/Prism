/**
 * `/skills`, a screen over pi's own skill mechanism, which already works: skills found in the
 * skill folders and packages are listed in the system prompt by name and description, and the model reads a
 * skill's instructions only when a task calls for them. This screen adds nothing to that. It shows the skills
 * the package manager resolves (global, project, packages) and where each comes from; turns one on or off with
 * the same `+`/`-` patterns as `prism config`; installs, updates and removes skill packages as `prism install`,
 * `prism update` and `prism remove` do. Changes apply by reloading when the screen closes.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { getAgentDir } from "../config.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../core/extensions/types.ts";
import { DefaultPackageManager, type ResolvedResource } from "../core/package-manager.ts";
import { type PackageSource, SettingsManager } from "../core/settings-manager.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { isLocalPath, resolvePath } from "../utils/paths.ts";
import { fill, t } from "./i18n/index.ts";
import { nativeChoices } from "./native-choice.ts";
import { setSettingsSection } from "./settings-sections.ts";

const SKILLS_HELP = [
	"A skill is a set of instructions for one kind of task. The model sees the name and description of each skill that is on, and reads the rest only when a task calls for it.",
];
const SOURCE_HINT = "npm:name, git:github.com/user/repo, a URL or a local folder";
const NO_SKILL =
	"{0} is installed, but Prism found no skill in it: skills go in its skills folder, or where the pi key of its package.json says. Remove it?";
// shown before a package is installed or updated (docs/packages.md says the same).
const THIRD_PARTY_WARNING =
	"A package can run extension code on your machine, and bring skills that ask the model to run programs. Install or update only a source you have reviewed and trust.";

export interface SkillEntry {
	name: string;
	description: string;
	resource: ResolvedResource;
}

/** The skill's name and description from its frontmatter; its folder name when it has none. */
export function describeSkill(resource: ResolvedResource): SkillEntry {
	let frontmatter: Record<string, unknown> = {};
	try {
		frontmatter = parseFrontmatter(readFileSync(resource.path, "utf8")).frontmatter;
	} catch {
		// Unreadable: listed by its path, so it can still be turned off.
	}
	const fallback =
		basename(resource.path) === "SKILL.md" ? basename(dirname(resource.path)) : basename(resource.path, ".md");
	return {
		name: typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : fallback,
		description: typeof frontmatter.description === "string" ? frontmatter.description : "",
		resource,
	};
}

/** Where the skill comes from, in a few words. */
export function skillOrigin(resource: ResolvedResource): string {
	const { scope, origin, source } = resource.metadata;
	const where =
		scope === "project" ? t("this project") : scope === "temporary" ? t("this session") : t("all projects");
	return origin === "package" ? fill("{0}, package {1}", where, source) : fill("{0}, folder", where);
}

/**
 * Turns a skill on or off in settings.json, as `prism config` does (config-selector.ts): a `+` or `-` pattern
 * relative to its folder in the `skills` setting, or in the filters of its package.
 */
export function setSkillEnabled(
	settings: SettingsManager,
	resource: ResolvedResource,
	enabled: boolean,
	agentDir = getAgentDir(),
	cwd = process.cwd(),
): void {
	const { scope, origin, source, baseDir } = resource.metadata;
	const project = scope === "project";
	const replace = (current: readonly string[], pattern: string) => [
		...current.filter((entry) => entry.replace(/^[!+-]/, "") !== pattern),
		`${enabled ? "+" : "-"}${pattern}`,
	];
	if (origin === "top-level") {
		const pattern = relative(baseDir ?? (project ? join(cwd, ".pi") : agentDir), resource.path);
		const current = (project ? settings.getProjectSettings() : settings.getGlobalSettings()).skills ?? [];
		if (project) settings.setProjectSkillPaths(replace(current, pattern));
		else settings.setSkillPaths(replace(current, pattern));
		return;
	}
	const packages = [...((project ? settings.getProjectSettings() : settings.getGlobalSettings()).packages ?? [])];
	const index = packages.findIndex((entry) => (typeof entry === "string" ? entry : entry.source) === source);
	if (index === -1) return;
	const entry = packages[index]!;
	const current: Exclude<PackageSource, string> = typeof entry === "string" ? { source: entry } : { ...entry };
	current.skills = replace(current.skills ?? [], relative(baseDir ?? dirname(resource.path), resource.path));
	packages[index] = current;
	if (project) settings.setProjectPackages(packages);
	else settings.setPackages(packages);
}

/** Where a package applies, in a few words. */
const packageScope = (local: boolean) => t(local ? "this project" : "all projects");

export default function skillsExtension(pi: ExtensionAPI) {
	const open = async (ctx: ExtensionCommandContext) => {
		const native = nativeChoices(ctx);
		const agentDir = getAgentDir();
		const trusted = ctx.isProjectTrusted();
		const managers = () => {
			const settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: trusted });
			return {
				settings,
				packages: new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager: settings }),
			};
		};
		const fail = (error: unknown) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		let changed = false;
		while (true) {
			const { settings, packages } = managers();
			let skills: SkillEntry[];
			try {
				skills = (await packages.resolve(async () => "skip")).skills.map(describeSkill);
			} catch (error) {
				fail(error);
				return;
			}
			const rows = skills.map(
				(skill) =>
					`${skill.name} — ${skill.resource.enabled ? t("on") : t("off")} — ${skillOrigin(skill.resource)}`,
			);
			const install = t("Install a skill…");
			const update = t("Update skill packages");
			const close = t("Close");
			// Each package once, with whether it applies to this project only.
			const sources = [
				...new Map(
					skills
						.filter((s) => s.resource.metadata.origin === "package")
						.map((s) => [s.resource.metadata.source, s.resource.metadata.scope === "project"] as const),
				),
			];
			const help = SKILLS_HELP.map(t);
			if (skills.length === 0)
				help.push(
					fill(
						"No skill yet: install one, or add a folder with a SKILL.md file to {0}.",
						join(agentDir, "skills"),
					),
				);
			let choice: string | undefined;
			let selectedSkill: SkillEntry | undefined;
			if (native) {
				const selected = await native({
					screenId: "skills",
					title: t("Skills"),
					doneLabel: close,
					lines: help,
					items: [
						...skills.map((skill, index) => ({
							id: `skill:${index}`,
							label: skill.name,
							description: `${skill.description}\n${skillOrigin(skill.resource)}`,
							statusText: t(skill.resource.enabled ? "on" : "off"),
							searchText: skill.resource.path,
						})),
						{ id: "install", label: install },
						...(sources.length ? [{ id: "update", label: update }] : []),
					],
				});
				if (selected === "install") choice = install;
				else if (selected === "update") choice = update;
				else if (selected?.startsWith("skill:")) {
					selectedSkill = skills[Number(selected.slice(6))];
					choice = selected;
				}
			} else
				choice = await ctx.ui.select([t("Skills"), ...help].join("\n"), [
					...rows,
					install,
					...(sources.length > 0 ? [update] : []),
					close,
				]);
			if (!choice || choice === close) break;
			if (choice === install) {
				const local =
					trusted &&
					(await ctx.ui.select(t("Install for"), [t("All projects (global)"), t("This project only")])) ===
						t("This project only");
				const source = (await ctx.ui.input(t("Source of the skill package"), t(SOURCE_HINT)))?.trim();
				if (!source) continue;
				const details = [
					fill("Source: {0}", source),
					fill("For: {0}", packageScope(local)),
					"",
					t(THIRD_PARTY_WARNING),
				];
				if (!(await ctx.ui.confirm(t("Install this skill package?"), details.join("\n")))) {
					ctx.ui.notify(t("Nothing was installed."));
					continue;
				}
				ctx.ui.notify(fill("Installing {0}…", source));
				try {
					await packages.installAndPersist(source, { local });
					await settings.flush();
					changed = true;
					// fork.9 QA: a package without skills would be listed nowhere here, so it could not be removed.
					// Installation reads local input from cwd; this resolver otherwise reads it from settings' directory.
					const installedSource = isLocalPath(source) ? resolvePath(source, ctx.cwd) : source;
					const brought = (await packages.resolveExtensionSources([installedSource], { local })).skills.length;
					if (brought > 0) ctx.ui.notify(fill("Installed {0}.", source));
					else if (await ctx.ui.confirm(t("This package brings no skill"), fill(NO_SKILL, source))) {
						await packages.removeAndPersist(source, { local });
						await settings.flush();
						ctx.ui.notify(fill("Removed {0}.", source));
					} else ctx.ui.notify(fill("Installed {0}, without skills.", source));
				} catch (error) {
					fail(error);
				}
				continue;
			}
			if (choice === update) {
				const details = [
					...sources.map(([source, local]) => `${source} — ${packageScope(local)}`),
					"",
					t(THIRD_PARTY_WARNING),
				];
				if (!(await ctx.ui.confirm(t("Update these skill packages?"), details.join("\n")))) {
					ctx.ui.notify(t("Nothing was updated."));
					continue;
				}
				// fork: "up to date" only when every update went through.
				let failed = false;
				for (const [source, local] of sources) {
					try {
						// only the scope shown, not a hidden global copy as well.
						await packages.update(source, { local });
						changed = true;
					} catch (error) {
						failed = true;
						fail(error);
					}
				}
				ctx.ui.notify(
					t(failed ? "Some skill packages were not updated." : "Skill packages are up to date."),
					failed ? "warning" : undefined,
				);
				continue;
			}
			const skill = selectedSkill ?? skills[rows.indexOf(choice)];
			if (!skill) continue;
			const { resource } = skill;
			const toggle = resource.enabled ? t("Turn it off") : t("Turn it on");
			const remove = t("Remove its package");
			const isPackage = resource.metadata.origin === "package";
			const title = [skill.name, skill.description, skillOrigin(resource), resource.path].filter(Boolean).join("\n");
			let action: string | undefined;
			if (native) {
				const selected = await native({
					screenId: `skill:${resource.path}`,
					title: skill.name,
					kind: "actions",
					lines: [skill.description, skillOrigin(resource), resource.path].filter(Boolean),
					items: [{ id: "toggle", label: toggle }, ...(isPackage ? [{ id: "remove", label: remove }] : [])],
				});
				if (selected === "toggle") action = toggle;
				else if (selected === "remove") action = remove;
			} else action = await ctx.ui.select(title, [toggle, ...(isPackage ? [remove] : []), t("Back")]);
			try {
				if (action === toggle) {
					setSkillEnabled(settings, resource, !resource.enabled, agentDir, ctx.cwd);
					await settings.flush();
					changed = true;
				} else if (
					action === remove &&
					(await ctx.ui.confirm(
						t("Remove this package?"),
						fill("This removes {0} and every skill it brings.", resource.metadata.source),
					))
				) {
					await packages.removeAndPersist(resource.metadata.source, {
						local: resource.metadata.scope === "project",
					});
					await settings.flush();
					changed = true;
				}
			} catch (error) {
				fail(error);
			}
		}
		// The skill list in the prompt and the /skill: commands are built when resources load.
		if (changed) await ctx.reload();
	};

	pi.registerCommand("skills", {
		description: t("Install, turn on or off, update and remove skills"),
		handler: async (_args, ctx) => open(ctx),
	});
	pi.on("session_start", () => {
		setSettingsSection("skills", {
			domain: "conversation",
			items: () => [
				{
					id: "command:skills",
					label: "Skills",
					description: "Install, turn on or off, update and remove skills (also /skills).",
					currentValue: "open",
					values: ["open"],
				},
			],
		});
	});
	pi.on("session_shutdown", () => setSettingsSection("skills", undefined));
}
