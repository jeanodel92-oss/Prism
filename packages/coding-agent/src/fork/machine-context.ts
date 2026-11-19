/**
 * fork: a short `<machine>` section in the system prompt: the user's system, desktop,
 * hardware and shell. Models otherwise guess, and the shell matters most: told nothing, they give bash syntax to a
 * fish or zsh user and stumble on it each time. The bash tool always runs bash, so the section says both.
 *
 * Read once per process, rounded to whole gigabytes, so the section stays the same for the whole session and does
 * not resend the system prompt. `-builtin:machine-context` in the `extensions` setting leaves it out.
 */
import { readFileSync, statfsSync } from "node:fs";
import { arch, cpus, homedir, release, totalmem, type } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI } from "../core/extensions/types.ts";

const GB = 1024 ** 3;

function distribution(): string {
	if (process.platform !== "linux") return `${type()} ${release()}`;
	try {
		const osRelease = readFileSync("/etc/os-release", "utf8");
		const name = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(osRelease)?.[1];
		if (name) return `${name}, kernel ${release()}`;
	} catch {
		// No os-release: the kernel alone.
	}
	return `Linux, kernel ${release()}`;
}

function desktop(env: NodeJS.ProcessEnv): string | undefined {
	const name = env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION;
	if (!name) return undefined;
	const session = env.XDG_SESSION_TYPE;
	return session ? `${name} (${session})` : name;
}

function disk(): string | undefined {
	try {
		const stats = statfsSync(homedir());
		const free = Math.round((stats.bavail * stats.bsize) / GB);
		const total = Math.round((stats.blocks * stats.bsize) / GB);
		return `${free} GB free of ${total} GB in the home folder`;
	} catch {
		return undefined;
	}
}

/** The `<machine>` section's text. */
export function machineContext(env: NodeJS.ProcessEnv = process.env): string {
	const processors = cpus();
	const system = [distribution(), arch(), desktop(env)].filter(Boolean).join(", ");
	const hardware = [
		processors.length > 0 ? `CPU ${processors[0].model.trim()} (${processors.length} threads)` : undefined,
		`RAM ${Math.round(totalmem() / GB)} GB`,
		disk(),
	].filter(Boolean);
	const shell = env.SHELL ? basename(env.SHELL) : undefined;
	const lines = [`System: ${system}`, `Hardware: ${hardware.join(", ")}`];
	if (shell) {
		lines.push(
			shell === "bash"
				? "User's shell: bash."
				: `User's shell: ${shell}. Write ${shell} syntax for commands the user types and for its config files; your bash tool still runs bash.`,
		);
	}
	return lines.join("\n");
}

export default function machineContextExtension(pi: ExtensionAPI) {
	let section: string | undefined;
	pi.on("before_agent_start", async (event) => {
		section ??= machineContext();
		event.systemPromptOptions.sections.machine = section;
	});
}
