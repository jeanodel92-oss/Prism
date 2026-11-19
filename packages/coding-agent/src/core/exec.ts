/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { constants as osConstants } from "node:os";
import { launch } from "../fork/child-process.ts";
import { waitForChildProcess } from "../utils/child-process.ts";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		// fork: in its own process group, stopped on timeout or abort with
		// SIGTERM to the group, then SIGKILL after 5 s unless the group ended (`proc.killed` only said SIGTERM was sent).
		const launched = launch(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			graceMs: 5000,
		});
		const proc = launched.child;
		// fork: the timeout and the abort stop the command while it
		// runs only. A worker it started and left running after it exited is not killed later.
		const stop = () => void launched.stop();
		const limit =
			options?.timeout !== undefined && options.timeout > 0 ? setTimeout(stop, options.timeout) : undefined;
		if (options?.signal?.aborted) stop();
		else options?.signal?.addEventListener("abort", stop, { once: true });
		const release = () => {
			if (limit) clearTimeout(limit);
			options?.signal?.removeEventListener("abort", stop);
		};

		let stdout = "";
		let stderr = "";

		// fork: a decoder per stream keeps a character split across chunks.
		proc.stdout?.setEncoding("utf8");
		proc.stderr?.setEncoding("utf8");
		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcess(proc)
			.then((code) => {
				release();
				// fork: a signal is 128 + its number, as in the bash tool, never 0.
				const signal = proc.signalCode;
				resolve({
					stdout,
					stderr,
					code: code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1),
					killed: launched.stopping,
				});
			})
			.catch((_err) => {
				release();
				resolve({ stdout, stderr, code: 1, killed: launched.stopping });
			});
	});
}
