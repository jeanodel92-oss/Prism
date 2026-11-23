/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { constants as bufferConstants } from "node:buffer";
import { constants as osConstants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { launch } from "../fork/child-process.ts";
import { waitForChildProcess } from "../utils/child-process.ts";

const DEFAULT_EXEC_MAX_BUFFER = Math.min(256 * 1024 * 1024, bufferConstants.MAX_STRING_LENGTH);

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
	/**
	 * Combined stdout/stderr byte limit; exceeding it terminates the command with `truncated: true`.
	 * Nonnegative integer up to the runtime string limit. Default: 256 MiB, capped by that limit.
	 */
	maxBuffer?: number;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
	/** Output exceeded `maxBuffer`; stdout and stderr are incomplete and `code` is nonzero. */
	truncated: boolean;
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
	// fork: upstream c466a3595 (#11546), output capped so a huge output cannot crash Prism with "Invalid string length".
	const maxBuffer = options?.maxBuffer ?? DEFAULT_EXEC_MAX_BUFFER;
	if (!Number.isInteger(maxBuffer) || maxBuffer < 0 || maxBuffer > bufferConstants.MAX_STRING_LENGTH) {
		throw new RangeError(`maxBuffer must be an integer between 0 and ${bufferConstants.MAX_STRING_LENGTH} bytes`);
	}
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
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		let outputBytes = 0;
		let truncated = false;
		// Keep only bytes within the combined cap. Close both pipes on overflow so writing descendants cannot keep
		// waitForChildProcess busy after the child exits.
		const takeWithinCap = (data: Buffer): Buffer | undefined => {
			if (truncated) return undefined;
			const remaining = maxBuffer - outputBytes;
			if (data.length <= remaining) {
				outputBytes += data.length;
				return data;
			}
			truncated = true;
			proc.stdout?.destroy();
			proc.stderr?.destroy();
			stop();
			return remaining > 0 ? data.subarray(0, remaining) : undefined;
		};
		proc.stdout?.on("data", (data: Buffer) => {
			const chunk = takeWithinCap(data);
			if (chunk) stdout += stdoutDecoder.write(chunk);
		});

		proc.stderr?.on("data", (data: Buffer) => {
			const chunk = takeWithinCap(data);
			if (chunk) stderr += stderrDecoder.write(chunk);
		});
		// On truncation, an incomplete UTF-8 suffix is dropped rather than flushed as a replacement character.
		const flush = () => {
			if (truncated) return;
			stdout += stdoutDecoder.end();
			stderr += stderrDecoder.end();
		};

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcess(proc)
			.then((code) => {
				release();
				flush();
				// fork: a signal is 128 + its number, as in the bash tool, never 0.
				const signal = proc.signalCode;
				const exitCode = code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1);
				resolve({
					stdout,
					stderr,
					// A truncated result must never read as success.
					code: truncated && exitCode === 0 ? 1 : exitCode,
					killed: launched.stopping,
					truncated,
				});
			})
			.catch((error: unknown) => {
				release();
				flush();
				// fork: upstream c60de42e9 (#11085), a spawn error (e.g. ENOENT) is reported instead of an empty stderr.
				if (!stderr && error instanceof Error) stderr = error.message;
				resolve({ stdout, stderr, code: 1, killed: launched.stopping, truncated });
			});
	});
}
