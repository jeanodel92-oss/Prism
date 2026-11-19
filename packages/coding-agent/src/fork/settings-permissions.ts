/**
 * fork: the Permissions & sandbox domain of `/settings`
 * the session's mode and the default one, the saved rules and protected paths, and the sandbox's
 * settings. The permission gate (permissions.ts) adds this section while its session runs; the model still
 * cannot change any of it (a tool call writing these files is a dangerous call, and a project's settings.json never reaches the sandbox)
 * .
 */
import type { SettingItem } from "@earendil-works/pi-tui";
import { saveGlobalSetting } from "./global-settings.ts";
import { t } from "./i18n/index.ts";
import type { Mode } from "./permissions.ts";
import { type SandboxSettings, SandboxSettingsError } from "./sandbox/layout.ts";
import { shown } from "./settings-domains.ts";
import type { ListEditorOptions, ListEntry } from "./settings-list-editor.ts";
import { paged, type SettingsPage } from "./settings-pages.ts";
import type { SectionContext, SettingsSection } from "./settings-sections.ts";
import { maxScopeMinutes } from "./task-scope.ts";

export type PermissionScope = "global" | "project";
export type PermissionList = "allow" | "ask" | "deny" | "protectedPaths";
/** A list of the sandbox settings, by its path in the `sandbox` object. */
type SandboxList = "network.allow" | "network.deny" | "excludedCommands" | "allowWrite" | "hide";

export interface PermissionSettingsDeps {
	mode(): Mode;
	/** The modes the session may switch to from here: unrestricted only once its warning was accepted. */
	modes(): readonly Mode[];
	setMode(mode: Mode): void | Promise<void>;
	defaultMode(): Mode;
	/** Saves the default mode; throws when permissions.json cannot be read or written. */
	setDefaultMode(mode: Mode): void | Promise<void>;
	projectTrusted(): boolean;
	/** One list of a permissions file (global, or the trusted project's). */
	readList(scope: PermissionScope, list: PermissionList): string[];
	/**
	 * Changes one list of a permissions file from its content under the file's lock (a list read before the lock lost another session's rule)
	 * ; throws when the file cannot be read or written.
	 */
	changeList(
		scope: PermissionScope,
		list: PermissionList,
		change: (current: string[]) => string[],
	): void | Promise<void>;
	/** A rule as saved (`tool` or `tool(glob)`), or an Error. */
	parseRule(text: string): string | Error;
	/** fork: what was given for this project, in words, and as saved; kept in Prism's folder. */
	projectGrants(): { id: string; label: string; detail: string }[];
	addProjectRule(rule: string): void | Promise<void>;
	/** Takes a permission given for this project back, by its id; a host also loses its open connections. */
	removeProjectGrant(id: string): void | Promise<void>;
	/** Paths Prism always protects. */
	defaultProtectedPaths: readonly string[];
	/** fork: the tools of the resource table found in the home folder, with the folders they read. */
	readTools(): { name: string; paths: string[] }[];
	/** fork: a path to make readable, as its real path, or why it cannot be. */
	parseReadable(text: string): string | Error;
	/** A path as shown, ~ for the home folder. */
	shortPath(path: string): string;
	sandbox(): SandboxSettings;
	/** Saves one sandbox setting and applies it to the session; throws when settings.json cannot be written. */
	saveSandbox(path: readonly string[], value: unknown): void | Promise<void>;
	/** The sandbox's state now, as `/sandbox` printed it; `broken` when it is on but does not work. */
	sandboxState(): { label: string; lines: string[]; broken: boolean };
	/** Starts the session's sandbox again, after the user fixed what stopped it, and says how it went. */
	checkSandbox(): void | Promise<void>;
	/** Shows a failure to save a setting changed in place (lists show theirs on their page). */
	report(message: string): void;
}

const MODE_ORDER: readonly Mode[] = ["safe", "ask", "broad", "unrestricted"];
const SANDBOX_MODES = ["safe", "ask", "broad", "unrestricted"] as const;
const RULE_EFFECTS = ["allow", "ask", "deny"] as const;

/** Ids the simple interface leaves out. */
const ADVANCED = new Set([
	"sandbox-write",
	"sandbox-hide",
	"perm-protected",
	// the simple interface keeps the mode, what was allowed, the sandbox and
	// what the agent reads; the rules' syntax, hosts, exceptions and the sandbox's finer switches are advanced.
	"perm-rules",
	"scope-max-minutes",
	"sandbox-modes",
	"sandbox-ask-hosts",
	"sandbox-allow-hosts",
	"sandbox-deny-hosts",
	"sandbox-user-commands",
	"sandbox-git-signing",
	"sandbox-containers",
	"sandbox-service-state",
	"sandbox-sudo",
	"sandbox-sudo-remember-password",
	"sandbox-excluded",
	"sandbox-read-tools",
	"sandbox-read-allow",
]);

const onOff = (on: boolean) => (on ? "on" : "off");

function summary(values: readonly string[], none = "none"): string {
	if (values.length === 0) return none;
	const text = values.slice(0, 2).join(", ");
	return values.length > 2 ? `${text}, …` : text;
}

export function permissionsSection(deps: PermissionSettingsDeps): SettingsSection {
	/** A setting changed in place: a failure is reported, the row shows the saved value again. */
	const save = async (path: readonly string[], value: unknown) => {
		try {
			await deps.saveSandbox(path, value);
		} catch (error) {
			deps.report(error instanceof Error ? error.message : String(error));
		}
	};
	const scopes = (): PermissionScope[] => (deps.projectTrusted() ? ["global", "project"] : ["global"]);
	const scopeStep = () =>
		deps.projectTrusted()
			? [
					{
						title: "Where to save it",
						options: [
							{ value: "project", label: "This project (.pi/permissions.json)" },
							{ value: "global", label: "Every project (permissions.json in Prism's folder)" },
						],
					},
				]
			: [];

	const rules = (): ListEntry[] =>
		scopes().flatMap((scope) =>
			RULE_EFFECTS.flatMap((effect) =>
				deps
					.readList(scope, effect)
					.map((rule) => ({ text: rule, tag: `${t(effect)} · ${t(scope)}`, key: `${scope} ${effect}` })),
			),
		);
	const protectedPaths = (): ListEntry[] => [
		...scopes().flatMap((scope) =>
			deps.readList(scope, "protectedPaths").map((path) => ({ text: path, tag: t(scope), key: scope })),
		),
		...deps.defaultProtectedPaths.map((path) => ({ text: path, fixed: true })),
	];

	const list = (
		context: SectionContext,
		done: (value?: string) => void,
		options: Pick<ListEditorOptions, "title" | "description" | "addPrompt" | "parse"> & {
			entries(): ListEntry[];
			steps?(): ReturnType<typeof scopeStep>;
			add(text: string, choices: string[]): void | Promise<void>;
			remove(entry: ListEntry): void | Promise<void>;
		},
	): SettingsPage => ({
		kind: "list",
		list: {
			...options,
			onAdd: options.add,
			onRemove: options.remove,
			requestRender: context.requestRender,
			// The row's value is read again when the section is rebuilt.
			done: (changed) => done(changed ? "changed" : undefined),
		},
	});

	const sandboxList = (
		id: string,
		label: string,
		description: string,
		key: SandboxList,
		addPrompt: string,
		context: SectionContext,
	): SettingItem => {
		const read = () => {
			const sandbox = deps.sandbox();
			return key === "network.allow"
				? sandbox.network.allow
				: key === "network.deny"
					? sandbox.network.deny
					: sandbox[key];
		};
		return {
			id,
			label,
			description,
			currentValue: summary(read()),
			...paged((_value, done) =>
				list(context, done, {
					title: label,
					description,
					addPrompt,
					entries: () => read().map((text) => ({ text })),
					add: async (text) => {
						if (!read().includes(text)) await deps.saveSandbox(key.split("."), [...read(), text]);
					},
					remove: async (entry) =>
						await deps.saveSandbox(
							key.split("."),
							read().filter((value) => value !== entry.text),
						),
				}),
			),
		};
	};

	const toolResources = (): SettingItem => {
		const tools = deps.readTools();
		const on = tools.filter((tool) => !deps.sandbox().read.toolsOff.includes(tool.name));
		return {
			id: "sandbox-read-tools",
			label: "Tools' resources",
			description:
				"What the tools found in your home folder need, readable by the agent: one line per tool, without its credentials.",
			currentValue: summary(on.map((tool) => tool.name)),
			...paged((_value, done) => {
				let changed = false;
				return {
					kind: "rows",
					title: "Tools' resources",
					description: "Each tool's folders, readable by the agent; its credentials stay hidden.",
					items: tools.map((tool) =>
						shown({
							id: tool.name,
							label: tool.name,
							description: tool.paths.join(", "),
							currentValue: onOff(!deps.sandbox().read.toolsOff.includes(tool.name)),
							values: ["on", "off"],
						}),
					),
					onChange: async (name, value) => {
						await save(["read", "tools", name], value === "on");
						changed = true;
					},
					onClose: () => done(changed ? "changed" : undefined),
				};
			}),
		};
	};

	/** Paths readable besides the project: for every project in settings.json, for this one in its grants. */
	const alsoReadable = (context: SectionContext): SettingItem => {
		const entries = (): ListEntry[] => [
			...deps.sandbox().read.allow.map((path) => ({ text: path, tag: t("every project"), key: "global" })),
			...deps.projectGrants().flatMap((grant) => {
				const path = /^readable\((.+)\)$/.exec(grant.detail)?.[1];
				return path ? [{ text: deps.shortPath(path), tag: t("this project"), key: grant.id }] : [];
			}),
		];
		const description =
			"Files and folders the agent may read besides the project and the tools' resources, with file tools and commands. Hidden paths do not open this way.";
		return {
			id: "sandbox-read-allow",
			label: "Also readable",
			description,
			currentValue: summary(entries().map((entry) => entry.text)),
			...paged((_value, done) =>
				list(context, done, {
					title: "Also readable",
					description,
					addPrompt: "A file or a folder, such as ~/Documents/specs",
					parse: deps.parseReadable,
					entries,
					steps: () => [
						{
							title: "Where it applies",
							options: [
								{ value: "project", label: "This project (kept in Prism's folder)" },
								{ value: "global", label: "Every project (settings.json in Prism's folder)" },
							],
						},
					],
					add: async (path, [scope]) => {
						if (scope === "project") return await deps.addProjectRule(`readable(${path})`);
						const allow = deps.sandbox().read.allow;
						const short = deps.shortPath(path);
						if (!allow.includes(short)) await deps.saveSandbox(["read", "allow"], [...allow, short]);
					},
					remove: async (entry) => {
						if (entry.key !== "global") {
							if (entry.key) await deps.removeProjectGrant(entry.key);
							return;
						}
						await deps.saveSandbox(
							["read", "allow"],
							deps.sandbox().read.allow.filter((path) => path !== entry.text),
						);
					},
				}),
			),
		};
	};

	return {
		domain: "permissions",
		items: (context) => {
			// sandbox settings that cannot be read show why, and nothing to change.
			let sandbox: SandboxSettings;
			try {
				sandbox = deps.sandbox();
			} catch (error) {
				if (!(error instanceof SandboxSettingsError)) throw error;
				return [
					{
						id: "sandbox-settings-error",
						label: "Sandbox",
						description: error.message,
						currentValue: t("cannot be read"),
						...paged((_value, done) => ({
							kind: "text",
							title: "Sandbox",
							lines: [error.message],
							done: () => done(),
						})),
					},
				];
			}
			const counts = RULE_EFFECTS.map((effect) => ({
				effect,
				count: scopes().reduce((n, scope) => n + deps.readList(scope, effect).length, 0),
			})).filter(({ count }) => count > 0);
			const yours = scopes().flatMap((scope) => deps.readList(scope, "protectedPaths"));
			const state = deps.sandboxState();
			const sandboxModes = SANDBOX_MODES.filter((mode) => sandbox.modes[mode]);
			return [
				{
					id: "perm-mode",
					label: "Mode",
					description:
						"What the agent may do without asking, in this session. alt+m cycles it; new sessions start in the default mode.",
					currentValue: deps.mode(),
					values: MODE_ORDER.filter((mode) => deps.modes().includes(mode) || mode === deps.mode()),
				},
				{
					id: "perm-default-mode",
					label: "Default mode",
					description: "The mode new sessions start in (permissions.json in Prism's folder).",
					currentValue: deps.defaultMode(),
					values: MODE_ORDER.filter((mode) => deps.modes().includes(mode) || mode === deps.defaultMode()),
				},
				{
					id: "command:perm window",
					label: "Modes and permissions in effect",
					description:
						"What each mode allows, the permissions given for a while or for this session (each can be revoked), and unrestricted mode the first time (also /perm window).",
					currentValue: "open",
					values: ["open"],
				},
				// fork: what a task may do without asking; the same screen as the agent's proposal.
				{
					id: "command:perm scope",
					label: "Task scope",
					// fork: reading outside the project is said to be limited only while the limit is on.
					description:
						sandbox.read.limit === "project" &&
						sandboxModes.includes(deps.mode() as (typeof sandboxModes)[number])
							? "Lets your next task change the project's files (and run sandboxed commands) without asking, for a set time, while you stay or go away. It limits the commands run, the files changed and the hosts sandboxed commands connect to, and reading stays limited to the project; it does not limit commands that run outside the sandbox, what MCP and LSP servers and your browser read themselves, or what an allowed program does with its connections (also /perm scope)."
							: "Lets your next task change the project's files (and run sandboxed commands) without asking, for a set time, while you stay or go away. It limits the commands run, the files changed and the hosts sandboxed commands connect to; it does not limit reading files outside the project (except hidden folders), commands that run outside the sandbox, or what an allowed program does with its connections (also /perm scope).",
					currentValue: "open",
					values: ["open"],
				},
				// fork.9 QA: the longest a task scope may last, here and in what the agent proposes.
				{
					id: "scope-max-minutes",
					label: "Longest task scope",
					description: "How long a task scope may last at most, for you and for what the agent proposes.",
					currentValue: `${maxScopeMinutes()} ${t("min")}`,
					...paged((_value, done) => ({
						kind: "input",
						input: {
							title: "Longest task scope",
							description: "How long a task scope may last at most, for you and for what the agent proposes.",
							current: `${maxScopeMinutes()} ${t("min")}`,
							parse: (text) => {
								const minutes = Number(text);
								return Number.isInteger(minutes) && minutes >= 5
									? String(minutes)
									: new Error(t("Type a whole number of minutes, 5 or more."));
							},
							save: (value) =>
								saveGlobalSetting(["scopeMaxMinutes"], value === undefined ? undefined : Number(value)),
							requestRender: context.requestRender,
							done: (changed) => done(changed ? "changed" : undefined),
						},
					})),
				},
				{
					id: "perm-rules",
					label: "Rules",
					description:
						"Saved rules: allow, ask or block actions that match, such as bash(npm run test*) or write(src/**). Rules given for this session are in Modes and permissions in effect.",
					currentValue:
						counts.length === 0 ? "none" : counts.map(({ effect, count }) => `${t(effect)} ${count}`).join(" · "),
					...paged((_value, done) =>
						list(context, done, {
							title: "Rules",
							description:
								"tool or tool(glob): * matches text within one folder, ** across folders. Enter on a rule removes it.",
							addPrompt: "A rule, such as bash(npm run test*) or write(src/**)",
							parse: deps.parseRule,
							entries: rules,
							steps: () => [
								{
									title: "What it does",
									options: [
										{ value: "allow", label: "allow: done without asking" },
										{ value: "ask", label: "ask: always asks" },
										{ value: "deny", label: "deny: blocked" },
									],
								},
								...scopeStep(),
							],
							add: async (text, [effect, scope]) => {
								const where = (scope ?? "global") as PermissionScope;
								const key = effect as (typeof RULE_EFFECTS)[number];
								await deps.changeList(where, key, (current) =>
									current.includes(text) ? current : [...current, text],
								);
							},
							remove: async (entry) => {
								const [scope, effect] = (entry.key ?? "").split(" ") as [PermissionScope, PermissionList];
								await deps.changeList(scope, effect, (current) =>
									current.filter((rule) => rule !== entry.text),
								);
							},
						}),
					),
				},
				{
					id: "perm-project",
					label: "Allowed or blocked in this project",
					description:
						"What you allowed or blocked for this project when asked. It comes back in every session on this folder; it is kept in Prism's folder, not in the project. Enter on one takes it back.",
					currentValue: summary(deps.projectGrants().map((grant) => grant.label)),
					...paged((_value, done) =>
						list(context, done, {
							title: "Allowed or blocked in this project",
							description: "Enter on one takes it back. Hosts for every project are in Allowed hosts.",
							addPrompt: "A rule, such as bash(npm run test*) or write(src/**)",
							parse: deps.parseRule,
							entries: () =>
								deps.projectGrants().map((grant) => ({ text: grant.label, tag: grant.detail, key: grant.id })),
							add: async (text) => await deps.addProjectRule(text),
							remove: async (entry) => {
								if (entry.key) await deps.removeProjectGrant(entry.key);
							},
						}),
					),
				},
				{
					id: "perm-protected",
					label: "Protected paths",
					description:
						"Files the agent must ask for, whatever the mode: keys, .env files, Git hooks. Yours are added to Prism's.",
					currentValue: summary([...yours, ...deps.defaultProtectedPaths]),
					...paged((_value, done) =>
						list(context, done, {
							title: "Protected paths",
							description: "A path or a glob, relative to the project: * within one folder, ** across folders.",
							addPrompt: "A path or a glob, such as secrets/** or *.sqlite",
							entries: protectedPaths,
							steps: scopeStep,
							add: async (text, [scope]) => {
								const where = (scope ?? "global") as PermissionScope;
								await deps.changeList(where, "protectedPaths", (current) =>
									current.includes(text) ? current : [...current, text],
								);
							},
							remove: async (entry) => {
								const scope = entry.key as PermissionScope;
								await deps.changeList(scope, "protectedPaths", (current) =>
									current.filter((path) => path !== entry.text),
								);
							},
						}),
					),
				},
				{
					id: "sandbox-state",
					label: "Sandbox",
					description:
						"Where shell commands run: in the sandbox, they write only to the project and caches, see no keys or credentials, and reach only the hosts you allow (also /sandbox).",
					currentValue: state.label,
					...paged((_value, done) => ({ kind: "text", title: "Sandbox", lines: state.lines, done: () => done() })),
				},
				// fork: a broken sandbox is fixed from here, without restarting.
				...(state.broken
					? [
							{
								id: "sandbox-check",
								label: "Check the sandbox again",
								description:
									"Once bubblewrap is installed or allowed (see Sandbox for how), checks again; shell commands run as soon as it works.",
								currentValue: "check",
								values: ["check"],
							},
						]
					: []),
				{
					id: "sandbox-modes",
					label: "In modes",
					description: "The permission modes whose shell commands run in the sandbox.",
					currentValue: sandboxModes.length === 0 ? "none" : sandboxModes.map((mode) => t(mode)).join(", "),
					...paged((_value, done) => {
						let changed = false;
						return {
							kind: "rows",
							title: "In modes",
							description: "Shell commands of these modes run in the sandbox.",
							items: SANDBOX_MODES.map((mode) =>
								shown({
									id: mode,
									label: mode,
									currentValue: onOff(deps.sandbox().modes[mode]),
									values: ["on", "off"],
								}),
							),
							onChange: async (mode, value) => {
								await save(["modes", mode], value === "on");
								changed = true;
							},
							onClose: () => done(changed ? "changed" : undefined),
						};
					}),
				},
				{
					id: "sandbox-ask-hosts",
					label: "Ask for new hosts",
					description:
						"A sandboxed command reaching a host not listed asks you; off, such a host passes without a question, except a port of this machine or Git over SSH, which open only when allowed. Blocked hosts stay blocked.",
					currentValue: onOff(sandbox.network.askNewHosts),
					values: ["on", "off"],
				},
				sandboxList(
					"sandbox-allow-hosts",
					"Allowed hosts",
					"Hosts sandboxed commands reach without asking. *.example.com covers its subdomains; localhost:5432 a single port of this machine, whose other ports stay closed; ssh://github.com Git over SSH to that host, with your SSH keys; nas.lan@192.168.1.10 lets that name lead to that address of your local network (asked otherwise).",
					"network.allow",
					"A host, such as registry.npmjs.org, *.github.com, localhost:5432 or ssh://github.com",
					context,
				),
				sandboxList(
					"sandbox-deny-hosts",
					"Blocked hosts",
					"Hosts sandboxed commands never reach, even when asked.",
					"network.deny",
					"A host, such as example.com or *.example.com",
					context,
				),
				{
					id: "sandbox-user-commands",
					label: "Your ! commands in the sandbox",
					description: "Run the commands you type with ! in the sandbox too; off, they run as you.",
					currentValue: onOff(sandbox.userCommands),
					values: ["on", "off"],
				},
				{
					id: "sandbox-git-signing",
					label: "Git signs with my key",
					description:
						"Let Git in the sandbox sign commits and tags with the signing key of your Git configuration. Prism signs them outside the sandbox; the key never enters it, and nothing else is signed.",
					currentValue: onOff(sandbox.gitSigning),
					values: ["on", "off"],
				},
				{
					id: "sandbox-containers",
					label: "Commands see my containers",
					description:
						"Let sandboxed commands list your Docker or Podman containers and images (docker ps, docker images), without changing them, inspecting them or reading their logs.",
					currentValue: onOff(sandbox.containers),
					values: ["on", "off"],
				},
				{
					id: "sandbox-service-state",
					label: "Commands read the state of services",
					description:
						"Let sandboxed commands read only service state fields over D-Bus (systemctl status, is-active, list-units, show -p ActiveState), without reading configuration or environment, or starting, stopping or changing services.",
					currentValue: onOff(sandbox.serviceState),
					values: ["on", "off"],
				},
				{
					id: "sandbox-sudo",
					label: "Commands as root (sudo)",
					description:
						"Give the agent a sudo tool: commands run as root outside the sandbox after your approval and password. You may allow sudo for this session and optionally remember the password for five minutes. Applies after /reload.",
					currentValue: onOff(sandbox.sudo),
					values: ["on", "off"],
				},
				...(sandbox.sudo
					? [
							{
								id: "sandbox-sudo-remember-password",
								label: "Remember sudo password for 5 minutes",
								description:
									"Keep the password in Prism's memory for 5 minutes after you type it, so the next sudo commands do not ask for it again. Never written anywhere. Only applies when sudo is on.",
								currentValue: onOff(sandbox.sudoRememberPassword),
								values: ["on", "off"],
							},
						]
					: []),
				sandboxList(
					"sandbox-excluded",
					"Run outside the sandbox",
					"Commands that run outside the sandbox, such as docker: a single command starting with one of these. They still get the permission check.",
					"excludedCommands",
					"A command, such as docker or docker compose",
					context,
				),
				// fork: Readable files.
				{
					id: "sandbox-read-limit",
					label: "What the agent reads",
					description:
						"project: the project, what its tools need and the paths you allow; commands do not see the rest of the home folder, other accounts or mounted disks, and file tools ask before reading them. all: everything but the hidden paths. MCP and LSP servers and your browser are not limited either way.",
					currentValue: sandbox.read.limit,
					values: ["project", "all"],
				},
				...(sandbox.read.limit === "project" ? [toolResources(), alsoReadable(context)] : []),
				sandboxList(
					"sandbox-write",
					"Writable paths",
					"Paths sandboxed commands may write besides the project, /tmp and the package caches. ~ is your home folder.",
					"allowWrite",
					"A path, such as ~/.local/share/pnpm",
					context,
				),
				sandboxList(
					"sandbox-hide",
					"Hidden paths",
					"Paths hidden from sandboxed commands besides keys, credentials and browser profiles. ~ is your home folder.",
					"hide",
					"A path, such as ~/Documents/private",
					context,
				),
			];
		},
		onChange: async (id, value) => {
			try {
				if (id === "perm-mode") {
					const mode = deps.modes().find((candidate) => candidate === value);
					if (mode) await deps.setMode(mode);
				} else if (id === "perm-default-mode") {
					const mode = deps.modes().find((candidate) => candidate === value);
					if (mode) await deps.setDefaultMode(mode);
				} else if (id === "sandbox-check") await deps.checkSandbox();
				else if (id === "sandbox-ask-hosts") await save(["network", "askNewHosts"], value === "on");
				else if (id === "sandbox-user-commands") await save(["userCommands"], value === "on");
				else if (id === "sandbox-git-signing") await save(["gitSigning"], value === "on");
				else if (id === "sandbox-containers") await save(["containers"], value === "on");
				else if (id === "sandbox-service-state") await save(["serviceState"], value === "on");
				else if (id === "sandbox-sudo") await save(["sudo"], value === "on");
				else if (id === "sandbox-sudo-remember-password") await save(["sudoRememberPassword"], value === "on");
				else if (id === "sandbox-read-limit") await save(["read", "limit"], value);
			} catch (error) {
				deps.report(error instanceof Error ? error.message : String(error));
			}
		},
		isAdvanced: (id) => ADVANCED.has(id),
	};
}
