/**
 * fork: what the model and the user are told about the sandbox. The model learns which
 * paths are hidden before it runs into them, and a failed command that touched one ends with a line
 * saying so, so a "Permission denied" from the sandbox is not taken for a bug.
 */

import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fill, labelled, t } from "../i18n/index.ts";
import type { SandboxLayout, SandboxSettings } from "./layout.ts";
import { homeRelative, within } from "./path-within.ts";

/** fork: the accesses to the user's services that the model is told about. */
type Services = Partial<Pick<SandboxSettings, "containers" | "serviceState">>;

/** The system prompt section while the sandbox is on. */
export function sandboxPromptSection(layout: SandboxLayout, services: Services = {}): string {
	return [
		"# Sandbox",
		"Your shell commands (bash, background) run in Prism's sandbox:",
		`- They can write only to: /tmp, ${layout.writable.map((path) => homeRelative(path)).join(", ")}. Elsewhere is read-only.`,
		// fork: the package caches keep a command's writes for that command only.
		...(layout.caches?.length
			? [
					`- In the package caches (${layout.caches.map((path) => homeRelative(path)).join(", ")}), what a command writes is kept for that command only, never in the user's caches.`,
				]
			: []),
		"- /tmp is private to this session: empty at first, shared by this session's commands only. The full output files Prism writes to /tmp are not in it: open them with the read tool.",
		`- These paths are hidden and give "Permission denied": ${layout.hidden.map((path) => homeRelative(path)).join(", ")}.`,
		...(layout.home
			? [
					`- Reading is limited to the project, the tools' resources (${layout.home.read.map((path) => homeRelative(path)).join(", ") || "none found"}) and the folders the user allowed. The rest of the home folder, other users' folders and mounted media (${layout.home.hiddenOutside.join(", ") || "none"}) are not shown: a file missing there may exist. ~/.cache is the project's own.`,
				]
			: []),
		...(layout.restrictions ?? []).map(
			({ path, reason }) =>
				`- Writes under ${path} are refused: ${reason}. Reads remain available; the sandbox stays on.`,
		),
		...(layout.privateGit?.length
			? [
					`- Git works normally (commits, branches, fetch) in: ${layout.privateGit.map(({ repository }) => homeRelative(repository)).join(", ")}. Git metadata changes are checked after each bash command, and when a background command ends (not before: until then they are not applied); changes that would run programs outside the sandbox (hooks, configuration) are refused with a note and kept, not lost.`,
				]
			: []),
		"- Network goes through Prism's proxy (HTTP_PROXY): the user allows each new host. Programs that ignore the proxy variables have no network. ssh itself has no network either; Git over SSH (git@host:repo, ssh://) goes through Prism, to the hosts the user allows (ssh://<host>). Unix sockets are blocked.",
		services.serviceState
			? "- The system bus goes through Prism, which lets commands read the state of services (systemctl status, is-active, show, list-units) and refuses any other call: starting, stopping or changing a service, logind, other services."
			: "- D-Bus is blocked: systemctl, busctl and loginctl cannot reach the system.",
		"- A process a bash command leaves running (`cmd &`, nohup, setsid) is stopped when that command ends. Run a server, a watcher or a long job with the background tool; without it, tell the user the process cannot keep running.",
		"- localhost is the sandbox's own, shared by the commands and background tasks of this session: a server one of them started is reachable there while it runs. The machine's services are reachable at host.prism.internal:<port>, only on the ports the user allowed (localhost:<port>, 1024 and above); a port allowed while a command runs is served at once.",
		services.containers
			? "- Containers and new namespaces (podman, docker, unshare) cannot run. docker ps, docker images, podman ps and podman images list the user's containers and images through Prism, without their environment, labels or command; inspect, logs and any change are refused."
			: "- Containers and new namespaces (podman, docker, unshare) cannot run.",
		"Do not work around the sandbox. When a task needs a hidden path, a host or something it blocks, ask the user.",
	].join("\n");
}

// fork: each line says what was blocked, that it is intended, and how the user can lift it,
// so the model neither retries in vain nor looks for another cause.
const INTENDED = "This is intended, not a fault of the command or the machine.";
const RUN_OUTSIDE =
	"Ask the user: they can run it outside the sandbox (Run outside the sandbox, /settings › Permissions & sandbox) or run it themselves.";

const DENIED = /Permission denied|Operation not permitted/i;
const NAMESPACE_FAILURE = /unshare failed|cannot clone|cannot re-exec|newuidmap|user namespaces?/i;
const CONTAINER_COMMAND =
	/(?:^|[\s;&|(])(?:sudo\s+)?(?:podman|docker|buildah|toolbox|distrobox|unshare|bwrap|flatpak)\b/;
const SOCKET_FAILURE =
	/failed to open socket: Operation not permitted|Failed to connect to (?:the |system scope |user scope )?bus|DBUS_SESSION_BUS_ADDRESS|org\.freedesktop\.DBus\.Error|Cannot connect to the Docker daemon|unix:\/\/\S*|\.sock\b/i;
// fork: Git over SSH goes through Prism; its failures are the remote's, or Prism's refusal line.
const SSH_COMMAND = /(?:^|[\s;&|(])(?:ssh|scp|sftp|rsync)\s/;
const SSH_FAILURE =
	/Could not read from remote|Bad owner or permissions|Permission denied|Connection (refused|timed out)|Could not resolve/i;
const OTHER_NETWORK =
	/socket: Operation not permitted|missing cap_net_raw|Could not resolve host(?:name)?|Temporary failure in name resolution|Name or service not known|Network is unreachable/i;
const CONNECT_FAILURE =
	/Connection refused|Could not connect|Failed to connect|ECONNREFUSED|connect: Connection|couldn't connect/i;
const LOCALHOST = /\blocalhost\b|\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\[::1\]|\b0\.0\.0\.0\b|\bhost\.prism\.internal\b/i;
// fork: a write refused because its path is outside the writable folders, or protected inside them.
const READ_ONLY = /Read-only file system|EROFS/;
const PATHS = /(?:^|[\s'"`‘(=])((?:\/|\.{1,2}\/|~\/)[^\s'"`’):,]*|[\w.-]+\/[^\s'"`’):,]*)/g;
const LISTING = /(?:^|[\s;&|(])(?:docker|podman)\s+(?:ps|images|container\s+ls|image\s+ls)\b/;
// fork: a path the limited home folder does not show; it is absent, not unreadable.
const NOT_SHOWN = /No such file or directory|Permission denied|ENOENT|EACCES|cannot access/;

/** The path of the home folder, outside what reading limited to the project shows, that a command failed on. */
function notShown(text: string, layout: SandboxLayout): string | undefined {
	const limit = layout.home;
	if (!limit) return undefined;
	const shown = [...limit.read, ...layout.writable, join(limit.path, ".cache")];
	for (const line of text.split("\n")) {
		const at = line.search(NOT_SHOWN);
		if (at < 0) continue;
		for (const [, found] of [...line.slice(0, at).matchAll(PATHS)].reverse()) {
			if (!found) continue;
			const path = found.startsWith("~/") ? join(limit.path, found.slice(2)) : resolve(layout.cwd, found);
			if (!within(path, limit.path) || path === limit.path) continue;
			// fork: a project's secret file hidden in safe mode is hidden, not outside the limit.
			if (layout.hidden.includes(path)) break;
			if (!shown.some((root) => within(path, root))) return path;
			break;
		}
	}
	return undefined;
}

/** Whether a line refused `path`, written relative to the command's folder (`cat: .env: Permission denied`). */
function deniedRelative(text: string, path: string): boolean {
	const named = new RegExp(`(?:^|[\\s'"\`‘])(?:\\./)?${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"’]?:`);
	return text.split("\n").some((line) => DENIED.test(line) && named.test(line));
}

/** The path a write was refused on, the last one before "Read-only file system" (`bash: <path>: ...`), if read-only. */
function readOnlyWrite(text: string, layout: SandboxLayout): { path: string; protectedPath: boolean } | undefined {
	const home = homedir();
	const writable = ["/tmp", ...layout.writable];
	for (const line of text.split("\n")) {
		const at = line.search(READ_ONLY);
		if (at < 0) continue;
		const found = [...line.slice(0, at).matchAll(PATHS)].at(-1)?.[1];
		if (!found) continue;
		const path = found.startsWith("~/") ? join(home, found.slice(2)) : resolve(layout.cwd, found);
		if (layout.privateGit?.some(({ gitDir }) => within(path, gitDir))) continue;
		if (layout.readOnly.some((root) => within(path, root))) return { path, protectedPath: true };
		if (!writable.some((root) => within(path, root))) return { path, protectedPath: false };
	}
	return undefined;
}

/**
 * The line added to a command's result when it failed on something the sandbox hides or blocks, or
 * undefined. `text` is the command and its output.
 */
export function sandboxResultNote(text: string, layout: SandboxLayout, services: Services = {}): string | undefined {
	if (
		layout.restrictions?.length &&
		/Read-only file system|EROFS|Permission denied|Operation not permitted|Device or resource busy/i.test(text)
	) {
		return `[Prism sandbox: writes are restricted: ${layout.restrictions.map(({ path, reason }) => `${path}: ${reason}`).join("; ")}. Reads and Prism remain available; the sandbox stays on. Ask the user to adjust the configuration on the host; do not work around it.]`;
	}
	const missing = notShown(text, layout);
	if (missing) {
		return `[Prism sandbox: ${homeRelative(missing, layout.home?.path)} is outside what the agent may read (the project, the tools' resources and the folders the user allowed), so the sandbox does not show it; it may exist. ${INTENDED} Do not look for another copy or another way to it; ask the user, who can allow it when a file tool asks or in /settings, Readable files; commands see it from the next one.]`;
	}
	const written = readOnlyWrite(text, layout);
	if (written?.protectedPath) {
		return `[Prism sandbox: ${homeRelative(written.path)} is protected: Git hooks and configuration and Prism's project settings stay read-only in the sandbox, in the project and in every writable folder, so that a later run outside it cannot be made to run something. ${INTENDED} Do not work around it; ask the user to make that change themselves.]`;
	}
	if (written) {
		return `[Prism sandbox: ${homeRelative(written.path)} is outside the folders commands may change (/tmp, ${layout.writable.map((path) => homeRelative(path)).join(", ")}). ${INTENDED} Ask the user: they can add its folder to Writable paths (/settings › Permissions & sandbox), where it keeps the project's protections; do not work around it.]`;
	}
	const [command = ""] = text.split("\n", 1);
	if (NAMESPACE_FAILURE.test(text) || (CONTAINER_COMMAND.test(command) && DENIED.test(text))) {
		const listing =
			!services.containers && LISTING.test(command)
				? " Listing them works once the user turns on « Commands see my containers » (/settings › Permissions & sandbox)."
				: "";
		return `[Prism sandbox: containers and new namespaces (podman, docker, unshare) cannot run in the sandbox.${listing} ${INTENDED} ${RUN_OUTSIDE}]`;
	}
	if (SOCKET_FAILURE.test(text) && DENIED.test(text)) {
		const hint = services.serviceState
			? ""
			: " Reading the state of services (systemctl status) works once the user turns on « Commands read the state of services » (/settings › Permissions & sandbox).";
		return `[Prism sandbox: Unix sockets (D-Bus, the Docker or Podman service) are blocked in the sandbox.${hint} ${INTENDED} Ask the user: they can run the command outside the sandbox (Run outside the sandbox, /settings › Permissions & sandbox) or run it themselves.]`;
	}
	if (OTHER_NETWORK.test(text) || (SSH_COMMAND.test(command) && SSH_FAILURE.test(text))) {
		return `[Prism sandbox: only HTTP and HTTPS through Prism's proxy, and Git over SSH to the hosts the user allows (ssh://<host>), reach the network; ssh, scp, rsync, ping and DNS lookups run directly have none. ${INTENDED} For Git, use an https:// address or ask the user to allow ssh://<host> (Allowed hosts, /settings › Permissions & sandbox); otherwise ask the user to run the command outside the sandbox (Run outside the sandbox) or to run it themselves.]`;
	}
	if (CONNECT_FAILURE.test(text) && LOCALHOST.test(text)) {
		return `[Prism sandbox: localhost here is the sandbox's own, not the machine's: a server started by a command or a background task of this session is reachable there while it runs. The machine's services are reachable at host.prism.internal:<port>, only on the ports the user allowed one by one (localhost:<port>, 1024 and above). ${INTENDED} Do not conclude that the service is down. Ask the user: they can allow that port (localhost:<port> in Allowed hosts, /settings › Permissions & sandbox), run the command outside the sandbox (Run outside the sandbox) or run it themselves.]`;
	}
	if (!DENIED.test(text)) return undefined;
	const home = homedir();
	const hit =
		layout.hidden.find((path) => text.includes(path) || text.includes(homeRelative(path, home))) ??
		layout.hidden.find((path) => within(path, layout.cwd) && deniedRelative(text, relative(layout.cwd, path)));
	if (hit) {
		return `[Prism sandbox: ${homeRelative(hit, home)} is hidden by the sandbox. Ask the user if you need it; do not work around it.]`;
	}
	return undefined;
}

/** Why the proxy refused a host: the user blocked it, nobody answered, or it is in the blocked hosts. */
export type HostRefusal = { host: string; why: "user" | "unanswered" | "blocked" | "scope" | "port" | "ssh" };

const REFUSAL_WHY: Record<HostRefusal["why"], string> = {
	user: "the user blocked it",
	unanswered: "nobody answered; the user may be away",
	blocked: "it is in the blocked hosts",
	scope: "outside the approved task scope while the user is away",
	port: "a port of this machine opens only when the user allows it, and questions are off",
	ssh: "Git over SSH to a host opens only when the user allows it, and questions are off",
};

/** The line added to a command's result when the proxy refused hosts while it ran, or undefined. */
export function networkRefusalNote(refusals: readonly HostRefusal[]): string | undefined {
	const seen = new Map<string, HostRefusal["why"]>();
	for (const refusal of refusals) seen.set(refusal.host, refusal.why);
	if (seen.size === 0) return undefined;
	const hosts = [...seen].map(([host, why]) => `${host} (${REFUSAL_WHY[why]})`).join(", ");
	return `[Prism sandbox: connections refused while this command ran: ${hosts}. ${INTENDED} Do not retry or reach these hosts another way; ask the user, who can allow them (Allowed hosts, /settings › Permissions & sandbox).]`;
}

/** /sandbox: the state and what the settings give, one line each. */
export function describeSandbox(input: {
	mode: string;
	active: boolean;
	error?: string;
	settings: SandboxSettings;
	layout?: SandboxLayout;
	/** fork: the private Git copies kept for the user (`describeGitCopies`). */
	gitCopies?: string[];
	/** fork: repositories commands made whose hooks or configuration run programs (`nested-git.ts`). */
	repositories?: Array<{ folder: string; reasons: string }>;
	settingsPath: string;
}): string[] {
	const { settings, layout } = input;
	const modes = Object.entries(settings.modes)
		.filter(([, on]) => on)
		.map(([mode]) => t(mode));
	const list = (values: readonly string[]) => (values.length ? values.join(", ") : t("(none)"));
	const state = input.error
		? fill("broken: {0}", t(input.error))
		: input.active
			? fill("on ({0} mode)", t(input.mode))
			: fill("off in {0} mode", t(input.mode));
	const lines = [labelled("Sandbox", state), labelled("Modes with the sandbox", list(modes))];
	if (input.error) {
		lines.push(
			t("Shell commands are blocked until it works; nothing runs outside it."),
			t(
				"Fix it as said above, then choose Check the sandbox again in /settings › Permissions & sandbox, or turn it off for this mode under In modes.",
			),
		);
	}
	if (layout) {
		lines.push(
			labelled(
				"Writable",
				list([fill("{0} (private to this session)", "/tmp"), ...layout.writable.map((path) => homeRelative(path))]),
			),
		);
		lines.push(labelled("Read-only inside them", list(layout.readOnly.map((path) => homeRelative(path)))));
		lines.push(
			labelled(
				"Git in a private copy",
				list(layout.privateGit?.map(({ repository }) => homeRelative(repository)) ?? []),
			),
		);
		lines.push(labelled("Hidden", list(layout.hidden.map((path) => homeRelative(path)))));
		if (layout.home) {
			lines.push(
				fill(
					"Readable in the home folder: the project and {0}; not shown: the rest, and {1}",
					list(layout.home.read.map((path) => homeRelative(path))),
					list(layout.home.hiddenOutside),
				),
			);
		}
		for (const { path, reason } of layout.restrictions ?? [])
			lines.push(
				fill(
					"Writes refused under {0}: {1}. Reads remain available; the sandbox stays on.",
					homeRelative(path),
					t(reason),
				),
			);
	}
	lines.push(...(input.gitCopies ?? []));
	if (input.repositories?.length)
		lines.push(
			labelled(
				"Git repositories that would run programs, to check before running Git there",
				input.repositories.map(({ folder, reasons }) => `${homeRelative(folder)} (${reasons})`).join(", "),
			),
		);
	lines.push(
		fill(
			"Network: through Prism's proxy; {0}",
			t(settings.network.askNewHosts ? "asks for each new host" : "new hosts pass without a question"),
		),
		labelled("Allowed hosts", list(settings.network.allow)),
		labelled("Blocked hosts", list(settings.network.deny)),
		// fork: with the setting on, the system bus is filtered, not blocked.
		t(
			settings.serviceState
				? "System D-Bus: commands read the state of services, other calls are refused; Unix sockets: blocked"
				: "System D-Bus and Unix sockets: blocked",
		),
		labelled("Your ! commands", t(settings.userCommands ? "in the sandbox" : "outside it")),
		labelled("Commands run outside", list(settings.excludedCommands)),
		"",
		fill('Settings: "sandbox" in {0}', input.settingsPath),
		t("Close"),
	);
	return lines;
}
