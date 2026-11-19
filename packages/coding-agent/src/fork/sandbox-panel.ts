// the window's /sandbox screen. The settings of /settings › Permissions & sandbox as
// data, with the same texts and the same saves (settings-permissions.ts): the window draws them and sends changes.
import { t } from "./i18n/index.ts";
import type { SandboxSettings } from "./sandbox/layout.ts";
import type { PermissionSettingsDeps } from "./settings-permissions.ts";

export interface SandboxListItem {
	text: string;
	tag?: string;
	/** What it is taken back by, for an item that is not simply its text. */
	key?: string;
}
export type SandboxField =
	| { kind: "switch"; id: string; label: string; help?: string; on: boolean }
	| { kind: "choice"; id: string; label: string; help: string; value: string; options: string[] }
	| {
			kind: "list";
			id: string;
			label: string;
			help: string;
			placeholder: string;
			items: SandboxListItem[];
			where?: Array<{ value: string; label: string }>;
	  };
export interface SandboxSection {
	id: string;
	title: string;
	help?: string;
	fields: SandboxField[];
}
export interface SandboxPanelState {
	/** Why the settings cannot be read: nothing can be changed until settings.json is fixed. */
	problem?: string;
	status?: { label: string; lines: string[]; check?: string };
	sections: SandboxSection[];
}

const READABLE = "read.allow";
const PATHS: Record<string, readonly string[]> = {
	"network.allow": ["network", "allow"],
	"network.deny": ["network", "deny"],
};

function listOf(sandbox: SandboxSettings, id: string): string[] {
	if (id === "network.allow") return sandbox.network.allow;
	if (id === "network.deny") return sandbox.network.deny;
	if (id === "excludedCommands") return sandbox.excludedCommands;
	if (id === "allowWrite") return sandbox.allowWrite;
	if (id === "hide") return sandbox.hide;
	throw new Error(`Unknown sandbox list: ${id}`);
}

export function sandboxPanelState(deps: PermissionSettingsDeps): SandboxPanelState {
	let sandbox: SandboxSettings;
	try {
		sandbox = deps.sandbox();
	} catch (error) {
		return { problem: error instanceof Error ? error.message : String(error), sections: [] };
	}
	const onOff = (id: string, label: string, help: string, on: boolean): SandboxField => ({
		kind: "switch",
		id,
		label: t(label),
		help: t(help),
		on,
	});
	const list = (id: string, label: string, help: string, placeholder: string): SandboxField => ({
		kind: "list",
		id,
		label: t(label),
		help: t(help),
		placeholder: t(placeholder),
		items: listOf(sandbox, id).map((text) => ({ text })),
	});
	const state = deps.sandboxState();
	const reading: SandboxField[] = [
		{
			kind: "choice",
			id: "read.limit",
			label: t("What the agent reads"),
			help: t(
				"project: the project, what its tools need and the paths you allow; commands do not see the rest of the home folder, other accounts or mounted disks, and file tools ask before reading them. all: everything but the hidden paths. MCP and LSP servers and your browser are not limited either way.",
			),
			value: sandbox.read.limit,
			options: ["project", "all"],
		},
	];
	if (sandbox.read.limit === "project") {
		for (const tool of deps.readTools())
			reading.push({
				kind: "switch",
				id: `read.tools.${tool.name}`,
				label: tool.name,
				help: tool.paths.join(", "),
				on: !sandbox.read.toolsOff.includes(tool.name),
			});
		reading.push({
			kind: "list",
			id: READABLE,
			label: t("Also readable"),
			help: t(
				"Files and folders the agent may read besides the project and the tools' resources, with file tools and commands. Hidden paths do not open this way.",
			),
			placeholder: t("A file or a folder, such as ~/Documents/specs"),
			items: [
				...sandbox.read.allow.map((text) => ({ text, tag: t("every project"), key: "global" })),
				...deps.projectGrants().flatMap((grant) => {
					const path = /^readable\((.+)\)$/.exec(grant.detail)?.[1];
					return path ? [{ text: deps.shortPath(path), tag: t("this project"), key: grant.id }] : [];
				}),
			],
			where: [
				{ value: "project", label: t("This project (kept in Prism's folder)") },
				{ value: "global", label: t("Every project (settings.json in Prism's folder)") },
			],
		});
	}
	return {
		status: {
			label: t(state.label),
			lines: state.lines.filter(Boolean).map((line) => t(line)),
			// A broken sandbox is fixed from here, without restarting, as in /settings.
			...(state.broken ? { check: t("Check the sandbox again") } : {}),
		},
		sections: [
			{
				id: "modes",
				title: t("In modes"),
				help: t("The permission modes whose shell commands run in the sandbox."),
				fields: (["safe", "ask", "broad", "unrestricted"] as const).map((mode) => ({
					kind: "switch",
					id: `modes.${mode}`,
					label: t(mode),
					on: sandbox.modes[mode],
				})),
			},
			{
				id: "network",
				title: t("Network"),
				fields: [
					onOff(
						"network.askNewHosts",
						"Ask for new hosts",
						"A sandboxed command reaching a host not listed asks you; off, such a host passes without a question, except a port of this machine or Git over SSH, which open only when allowed. Blocked hosts stay blocked.",
						sandbox.network.askNewHosts,
					),
					list(
						"network.allow",
						"Allowed hosts",
						"Hosts sandboxed commands reach without asking. *.example.com covers its subdomains; localhost:5432 a single port of this machine, whose other ports stay closed; ssh://github.com Git over SSH to that host, with your SSH keys; nas.lan@192.168.1.10 lets that name lead to that address of your local network (asked otherwise).",
						"A host, such as registry.npmjs.org, *.github.com, localhost:5432 or ssh://github.com",
					),
					list(
						"network.deny",
						"Blocked hosts",
						"Hosts sandboxed commands never reach, even when asked.",
						"A host, such as example.com or *.example.com",
					),
				],
			},
			{
				id: "commands",
				title: t("Commands"),
				fields: [
					onOff(
						"userCommands",
						"Your ! commands in the sandbox",
						"Run the commands you type with ! in the sandbox too; off, they run as you.",
						sandbox.userCommands,
					),
					onOff(
						"gitSigning",
						"Git signs with my key",
						"Let Git in the sandbox sign commits and tags with the signing key of your Git configuration. Prism signs them outside the sandbox; the key never enters it, and nothing else is signed.",
						sandbox.gitSigning,
					),
					onOff(
						"containers",
						"Commands see my containers",
						"Let sandboxed commands list your Docker or Podman containers and images (docker ps, docker images), without changing them, inspecting them or reading their logs.",
						sandbox.containers,
					),
					onOff(
						"serviceState",
						"Commands read the state of services",
						"Let sandboxed commands read only service state fields over D-Bus (systemctl status, is-active, list-units, show -p ActiveState), without reading configuration or environment, or starting, stopping or changing services.",
						sandbox.serviceState,
					),
					onOff(
						"sudo",
						"Commands as root (sudo)",
						"Give the agent a sudo tool: commands run as root outside the sandbox after your approval and password. You may allow sudo for this session and optionally remember the password for five minutes. Applies after /reload.",
						sandbox.sudo,
					),
					...(sandbox.sudo
						? [
								onOff(
									"sudoRememberPassword",
									"Remember sudo password for 5 minutes",
									"Keep the password in Prism's memory for 5 minutes after you type it, so the next sudo commands do not ask for it again. Never written anywhere. Only applies when sudo is on.",
									sandbox.sudoRememberPassword,
								),
							]
						: []),
					list(
						"excludedCommands",
						"Run outside the sandbox",
						"Commands that run outside the sandbox, such as docker: a single command starting with one of these. They still get the permission check.",
						"A command, such as docker or docker compose",
					),
				],
			},
			{
				id: "files",
				title: t("Files"),
				fields: [
					...reading,
					list(
						"allowWrite",
						"Writable paths",
						"Paths sandboxed commands may write besides the project, /tmp and the package caches. ~ is your home folder.",
						"A path, such as ~/.local/share/pnpm",
					),
					list(
						"hide",
						"Hidden paths",
						"Paths hidden from sandboxed commands besides keys, credentials and browser profiles. ~ is your home folder.",
						"A path, such as ~/Documents/private",
					),
				],
			},
		],
	};
}

function fieldOf(state: SandboxPanelState, id: unknown): SandboxField {
	const field = state.sections.flatMap((section) => section.fields).find((entry) => entry.id === id);
	if (!field) throw new Error(`Unknown sandbox setting: ${String(id)}`);
	return field;
}

/**
 * One setting changed: only what the screen offers now, so the window cannot write anything else in the settings.
 * Throws for a request the screen cannot send; a failure to save is thrown too, with its message.
 */
export async function setSandboxField(deps: PermissionSettingsDeps, id: unknown, value: unknown): Promise<void> {
	const field = fieldOf(sandboxPanelState(deps), id);
	if (field.kind === "switch" && typeof value === "boolean") {
		// A tool's name may hold a dot: it is one key of `read.tools`.
		const tool = field.id.startsWith("read.tools.") ? field.id.slice("read.tools.".length) : undefined;
		await deps.saveSandbox(tool ? ["read", "tools", tool] : field.id.split("."), value);
	} else if (field.kind === "choice" && typeof value === "string" && field.options.includes(value)) {
		await deps.saveSandbox(field.id.split("."), value);
	} else throw new Error(`Invalid value for ${field.id}`);
}

/** One entry added to, or removed from, a list of the screen; an entry that cannot be added says why. */
export async function changeSandboxList(
	deps: PermissionSettingsDeps,
	id: unknown,
	change: { action: "add" | "remove"; text: string; key?: string; where?: string },
): Promise<string | undefined> {
	const field = fieldOf(sandboxPanelState(deps), id);
	if (field.kind !== "list") throw new Error(`Not a list: ${field.id}`);
	const text = change.text.trim();
	if (change.action === "remove" && !field.items.some((item) => item.text === text && item.key === change.key))
		throw new Error(`No such entry: ${text}`);
	if (field.id === READABLE) return await changeReadable(deps, { ...change, text });
	if (!text) return undefined;
	const current = listOf(deps.sandbox(), field.id);
	const path = PATHS[field.id] ?? [field.id];
	if (change.action === "remove")
		await deps.saveSandbox(
			path,
			current.filter((entry) => entry !== text),
		);
	else if (!current.includes(text)) await deps.saveSandbox(path, [...current, text]);
	return undefined;
}

async function changeReadable(
	deps: PermissionSettingsDeps,
	change: { action: "add" | "remove"; text: string; key?: string; where?: string },
): Promise<string | undefined> {
	const allow = deps.sandbox().read.allow;
	if (change.action === "remove") {
		if (change.key === "global")
			await deps.saveSandbox(
				["read", "allow"],
				allow.filter((path) => path !== change.text),
			);
		else if (change.key) await deps.removeProjectGrant(change.key);
		return undefined;
	}
	if (!change.text) return undefined;
	const path = deps.parseReadable(change.text);
	if (path instanceof Error) return path.message;
	if (change.where === "project") await deps.addProjectRule(`readable(${path})`);
	else if (change.where === "global") {
		const short = deps.shortPath(path);
		if (!allow.includes(short)) await deps.saveSandbox(["read", "allow"], [...allow, short]);
	} else throw new Error("Where the path applies is required.");
	return undefined;
}
