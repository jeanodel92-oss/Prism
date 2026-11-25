// /phone: link a phone from the terminal: what "Link a phone" does in the window
// (fork/gui/ui/js/phone-link.js). The phone server is the bundled `prism-remote` (fork/android/server): started while
// this Prism runs or as a user service, asked for a one-time pairing code (drawn as a QR code in block characters),
// and asked to revoke a phone. The window's own mode, where its engines serve the phone, stays the window's.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type Component, getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { getPackageDir } from "../config.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../core/extensions/types.ts";
import { hostCommand, hostProgram } from "./host-program.ts";
import { fill, t } from "./i18n/index.ts";
import { launcherCommand } from "./launch-interface.ts";

/** The Android app, at the release's fixed address (fork/gui/ui/js/android-app.js). */
export const ANDROID_APP_URL = "https://prism.odelserver.space/releases/android/prism-android-arm64.apk";
const SERVICE = "prism-remote.service";
/** How long a starting server has to answer its first `status`. */
const START_WAIT_MS = 5000;

export interface RunResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}
export type Run = (program: string, args: string[]) => RunResult;

const executable = (path: string | undefined): path is string => {
	if (!path) return false;
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

/** `prism-remote`: the installation's (beside the window), a source checkout's build, or one on PATH. */
export function remoteProgram(env: NodeJS.ProcessEnv = process.env, packageDir = getPackageDir()): string | undefined {
	return (
		[
			env.PRISM_REMOTE_BIN,
			resolve(packageDir, "../../../gui/prism-remote"),
			resolve(packageDir, "../../fork/android/server/target/release/prism-remote"),
		].find(executable) ??
		// fork: never one the sandbox's commands could write.
		hostProgram("prism-remote", env.PATH)
	);
}

const defaultRun: Run = (program, args) => {
	try {
		const stdout = execFileSync(program, args, {
			encoding: "utf8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, stdout, stderr: "" };
	} catch (error) {
		const failed = error as { stdout?: string; stderr?: string; message: string };
		return { ok: false, stdout: failed.stdout ?? "", stderr: (failed.stderr || failed.message).trim() };
	}
};

/** A firewall that may block the server's port on the local network (fork/android/server/src/firewall.rs). */
export interface FirewallBlock {
	name: string;
	/** False when its rules could not be read: it may block the port. */
	certain: boolean;
	/** What opens the port, for the user to run. */
	command: string;
}

export interface ServerStatus {
	hosts: string[];
	port: number;
	firewall?: FirewallBlock | null;
}

export interface Invitation {
	code: string;
	qr: string;
	hosts: string[];
	port: number;
	firewall?: FirewallBlock | null;
}

/**
 * fork: ufw, on by default on CachyOS, dropped the phone at home and nothing said so. What
 * the server found, for the user; none without a firewall in the way.
 */
export function firewallLines(firewall: FirewallBlock | null | undefined, port: number): string[] {
	if (!firewall) return [];
	return [
		fill(
			firewall.certain
				? "The {0} firewall blocks port {1} on the local network: the phone can only come through Tailscale. To open it:"
				: "The {0} firewall is on and may block port {1} on the local network. If the phone cannot connect at home, open it:",
			firewall.name,
			String(port),
		),
		`  ${firewall.command}`,
	];
}

/** What the phone server answers; each call runs `prism-remote` once. */
export class PhoneServer {
	readonly program: string;
	private readonly run: Run;
	/** `--dir`: the server's folder, `~/.prism/remote` when not given. */
	private readonly dir: string[];

	constructor(program: string, run: Run = defaultRun, dir?: string) {
		this.program = program;
		this.run = run;
		this.dir = dir ? ["--dir", dir] : [];
	}

	/** The running server's addresses, or undefined when none runs. */
	status(): ServerStatus | undefined {
		const result = this.run(this.program, ["status", ...this.dir]);
		if (!result.ok) return undefined;
		try {
			return JSON.parse(result.stdout) as ServerStatus;
		} catch {
			return undefined;
		}
	}

	/** The fingerprints of the paired phones, running or not. */
	paired(): string[] {
		const result = this.run(this.program, ["devices", ...this.dir]);
		return result.ok ? result.stdout.split("\n").filter((line) => /^[0-9a-f]{64}$/i.test(line.trim())) : [];
	}

	/** A new one-time pairing code from the running server. */
	invite(): Invitation {
		const result = this.run(this.program, ["invite", ...this.dir]);
		if (!result.ok) throw new Error(result.stderr || t("The phone server does not answer."));
		const answer = JSON.parse(result.stdout) as Partial<Invitation> & { error?: string };
		if (answer.error || !answer.code) throw new Error(answer.error ?? t("The phone server does not answer."));
		return answer as Invitation;
	}

	revoke(fingerprint: string): void {
		const result = this.run(this.program, ["revoke", ...this.dir, fingerprint]);
		if (!result.ok) throw new Error(result.stderr);
	}
}

/** The user service's unit file. */
export function unitPath(env: NodeJS.ProcessEnv = process.env): string {
	const config = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
	return join(config, "systemd", "user", SERVICE);
}

/** The engine the server starts for a phone: this Prism, as the window's server does. */
export function engineEnv(command = launcherCommand()): Record<string, string> {
	const [program, ...args] = command;
	return {
		PRISM_REMOTE_ENGINE: program ?? "prism",
		...(args.length ? { PRISM_REMOTE_ENGINE_ARGS: JSON.stringify(args) } : {}),
	};
}

/** One `Environment=` line of a unit: quoted, with systemd's escapes (backslash, quote, and `%` for specifiers). */
const unitEnv = (name: string, value: string) =>
	`Environment="${name}=${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"\n`;

/** The same unit as the window writes (fork/gui/src-tauri/src/phone_link.rs `unit`). */
export function serviceUnit(program: string, env: Record<string, string>, path = process.env.PATH ?? ""): string {
	let lines = unitEnv("PATH", path);
	for (const [name, value] of Object.entries(env)) lines += unitEnv(name, value);
	return `[Unit]\nDescription=Prism phone server (prism-remote)\n\n[Service]\nExecStart=${program} serve\nWorkingDirectory=%h\n${lines}Restart=on-failure\n\n[Install]\nWantedBy=default.target\n`;
}

const systemctl = (run: Run, args: string[]) => run(hostCommand("systemctl"), ["--user", ...args]);

function serviceEnabled(run: Run): boolean {
	const result = systemctl(run, ["is-enabled", SERVICE]);
	return result.ok && result.stdout.trim() === "enabled";
}

/** A line of the QR code: block characters and spaces only. */
const isQrLine = (line: string) => line !== "" && /^[ █▀▄]+$/.test(line);

/** A pairing code on screen: the QR code, the text to paste and where the phone will look; any key closes it. */
class CodeView implements Component {
	private readonly lines: string[];
	private readonly close: () => void;

	constructor(lines: string[], close: () => void) {
		this.lines = lines;
		this.close = close;
	}

	invalidate(): void {}

	render(width: number): string[] {
		// A QR code cut by the edge cannot be scanned; a long line (the code to paste) wraps instead of being cut.
		const qrWidth = this.lines.reduce(
			(widest, line) => (isQrLine(line) ? Math.max(widest, visibleWidth(line)) : widest),
			0,
		);
		const lines = qrWidth > width ? this.lines.filter((line) => !isQrLine(line) || line === "") : this.lines;
		const shown = qrWidth > width ? [t("Widen the terminal to show the QR code."), ...lines] : lines;
		return shown.flatMap((line) => {
			if (visibleWidth(line) <= width) return [line];
			const parts: string[] = [];
			for (let rest = line; rest; rest = rest.slice(width)) parts.push(rest.slice(0, width));
			return parts;
		});
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "tui.select.confirm")) this.close();
	}
}

/** Tailscale's addresses are in 100.64.0.0/10 (fork/gui/ui/js/phone-link.js). */
export function isTailscale(host: string): boolean {
	const [a, b] = host.split(".").map(Number);
	return a === 100 && b !== undefined && b >= 64 && b < 128;
}

/** The code, as the window shows it: QR, text, addresses, and the app to install. */
export function codeLines(invitation: Invitation): string[] {
	return [
		t("Scan this code with the Prism app on the phone (valid 5 minutes):"),
		"",
		...invitation.qr.split("\n"),
		"",
		t("Or paste this code in the app:"),
		invitation.code,
		"",
		fill("The phone will try {0}, port {1}.", invitation.hosts.join(", "), String(invitation.port)),
		...(invitation.hosts.some(isTailscale)
			? []
			: [t("Without Tailscale, the phone reaches this PC on the same network only.")]),
		...firewallLines(invitation.firewall, invitation.port),
		fill("The Android app: {0}", ANDROID_APP_URL),
		"",
		t("Enter or Esc closes."),
	];
}

// The server this Prism started ("while this Prism is open"): one per process, stopped when Prism ends.
let child: ChildProcess | undefined;
let exitHooked = false;
const ownRunning = () => Boolean(child && child.exitCode === null && !child.killed);
const stopChild = () => {
	child?.kill();
	child = undefined;
};

export default function phoneLink(pi: ExtensionAPI): void {
	if (!exitHooked) {
		exitHooked = true;
		process.once("exit", () => child?.kill());
	}

	// What the server this Prism started said before it stopped: the reason, when it could not start.
	let said = "";
	const waitRunning = async (server: PhoneServer) => {
		const deadline = Date.now() + START_WAIT_MS;
		while (Date.now() < deadline) {
			if (server.status()) return;
			if (child && child.exitCode !== null) break;
			await new Promise((done) => setTimeout(done, 200));
		}
		throw new Error(said.trim().split("\n").at(-1) || t("The phone server did not start."));
	};

	const showCode = async (ctx: ExtensionCommandContext, server: PhoneServer) => {
		const lines = codeLines(server.invite());
		if (!ctx.hasUI) return ctx.ui.notify(lines.join("\n"));
		await ctx.ui.custom<void>((_tui, _theme, _keys, done) => new CodeView(lines, () => done(undefined)), {
			overlay: true,
			overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
		});
	};

	pi.registerCommand("phone", {
		description: t("Link a phone: the Prism app on Android uses this PC (/phone)"),
		handler: async (_args, ctx) => {
			const program = remoteProgram();
			if (!program) {
				ctx.ui.notify(
					t(
						"prism-remote is missing from this installation (from a source checkout: cargo build --release in fork/android/server).",
					),
					"error",
				);
				return;
			}
			const server = new PhoneServer(program);
			for (;;) {
				const running = server.status();
				const service = serviceEnabled(defaultRun);
				const phones = server.paired();
				const where = running
					? fill(
							"The phone server runs ({0}) on {1}, port {2}.",
							service
								? t("always, as a service")
								: ownRunning()
									? t("while this Prism is open")
									: t("started elsewhere"),
							running.hosts.join(", "),
							String(running.port),
						)
					: t("The phone server is stopped: no phone can reach this PC.");
				const blocked = running ? firewallLines(running.firewall, running.port).join(" ") : "";
				const title = `${where} ${phones.length ? fill("Linked phones: {0}.", String(phones.length)) : t("No phone linked yet.")}${blocked ? ` ${blocked}` : ""}`;
				const choices = new Map<string, () => Promise<boolean>>();
				if (running) {
					choices.set(t("Show a pairing code"), async () => {
						await showCode(ctx, server);
						return true;
					});
				} else {
					choices.set(t("Run while this Prism is open"), async () => {
						stopChild();
						said = "";
						child = spawn(program, ["serve", "--cwd", ctx.cwd], {
							stdio: ["ignore", "ignore", "pipe"],
							env: { ...process.env, ...engineEnv() },
						});
						child.on("error", (error) => {
							said += `${error.message}\n`;
						});
						// Kept short: only the reason it stops is needed.
						child.stderr?.on("data", (chunk: Buffer) => {
							said = (said + chunk.toString()).slice(-2000);
						});
						await waitRunning(server);
						await showCode(ctx, server);
						return true;
					});
					choices.set(t("Run always, as a user service"), async () => {
						const path = unitPath();
						mkdirSync(dirname(path), { recursive: true });
						writeFileSync(path, serviceUnit(program, engineEnv()));
						for (const args of [["daemon-reload"], ["enable", "--now", SERVICE]]) {
							const result = systemctl(defaultRun, args);
							if (!result.ok) throw new Error(result.stderr);
						}
						await waitRunning(server);
						await showCode(ctx, server);
						return true;
					});
				}
				if (service || ownRunning()) {
					choices.set(t("Stop the phone server"), async () => {
						stopChild();
						if (service) {
							const result = systemctl(defaultRun, ["disable", "--now", SERVICE]);
							if (!result.ok) throw new Error(result.stderr);
							rmSync(unitPath(), { force: true });
						}
						return false;
					});
				}
				for (const fingerprint of phones) {
					choices.set(fill("Revoke the phone {0}…", fingerprint.slice(0, 16)), async () => {
						const sure = await ctx.ui.confirm(
							t("Revoke this phone?"),
							t("It will have to be paired again with a new code."),
						);
						if (sure) server.revoke(fingerprint);
						return false;
					});
				}
				const choice = await ctx.ui.select(title, [...choices.keys()]);
				if (!choice) return;
				try {
					if (await choices.get(choice)?.()) return;
				} catch (error) {
					ctx.ui.notify((error as Error).message, "error");
					return;
				}
			}
		},
	});
}
