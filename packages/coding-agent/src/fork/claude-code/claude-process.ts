/**
 * one `claude -p` process in stream-json mode. Lines on stdout are queued as parsed objects and read
 * in order with `next()`; stdin takes user messages and control requests. The unmodified binary, with the
 * user's own login: Prism never reads Claude Code's credentials.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

/** Set to use another `claude` than the one on PATH (and in the tests, a fake one). */
export const CLAUDE_BIN_ENV = "PRISM_CLAUDE_BIN";

/** The `claude` binary to run, or undefined when there is none. */
export function findClaudeBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const override = env[CLAUDE_BIN_ENV]?.trim();
	if (override) return override;
	for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
		const candidate = join(dir, "claude");
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return undefined;
}

export interface ClaudeProcessOptions {
	binary: string;
	cwd: string;
	model?: string;
	effort?: string;
	systemPrompt?: string;
	/** The MCP server with Prism's tools; without it the process has no tool at all. */
	mcp?: { url: string; token: string; serverName: string };
}

export type StreamJson = Record<string, unknown> & { type?: string };

const STDERR_TAIL = 4000;

export class ClaudeProcess {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly dir: string;
	private readonly queue: StreamJson[] = [];
	private waiter: ((value: StreamJson | undefined) => void) | undefined;
	private stderr = "";
	private ended = false;
	private requestCounter = 0;
	exitCode: number | null = null;

	constructor(options: ClaudeProcessOptions) {
		// Private files for what would otherwise sit in the command line (a long system prompt, the token).
		this.dir = mkdtempSync(join(tmpdir(), "prism-claude-"));
		const args = [
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--tools",
			"",
			"--strict-mcp-config",
			"--no-session-persistence",
			// No user settings, hooks or CLAUDE.md: the context is Prism's.
			"--setting-sources",
			"",
			// Print mode otherwise asks the API to omit thinking: the blocks arrive empty (measured on 2.1.327; the
			// showThinkingSummaries setting does not override it there, this hidden flag does).
			"--thinking-display",
			"summarized",
		];
		if (options.systemPrompt !== undefined) {
			const file = join(this.dir, "system-prompt.md");
			writeFileSync(file, options.systemPrompt, { mode: 0o600 });
			args.push("--system-prompt-file", file);
		}
		if (options.mcp) {
			const file = join(this.dir, "mcp.json");
			const config = {
				mcpServers: {
					[options.mcp.serverName]: {
						type: "http",
						url: options.mcp.url,
						headers: { Authorization: `Bearer ${options.mcp.token}` },
					},
				},
			};
			writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
			// Prism's permission gate decides; Claude Code would otherwise refuse every call in print mode.
			args.push("--mcp-config", file, "--allowedTools", `mcp__${options.mcp.serverName}`);
		}
		if (options.model) args.push("--model", options.model);
		if (options.effort) args.push("--effort", options.effort);
		this.child = spawn(options.binary, args, {
			cwd: options.cwd,
			env: {
				...process.env,
				// Prism has its own memory and project instructions.
				CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
				CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
				// A call can wait for the user's approval: no MCP timeout of its own.
				MCP_TOOL_TIMEOUT: String(24 * 60 * 60 * 1000),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		const lines = createInterface({ input: this.child.stdout });
		lines.on("line", (line) => {
			if (!line.trim()) return;
			let parsed: StreamJson;
			try {
				parsed = JSON.parse(line) as StreamJson;
			} catch {
				return;
			}
			this.push(parsed);
		});
		this.child.stderr.on("data", (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString("utf-8")).slice(-STDERR_TAIL);
		});
		this.child.stdin.on("error", () => {});
		this.child.on("error", (error) => {
			this.stderr = (this.stderr + error.message).slice(-STDERR_TAIL);
			this.finish();
		});
		this.child.on("close", (code) => {
			this.exitCode = code;
			this.finish();
		});
	}

	get alive(): boolean {
		return !this.ended;
	}

	/** The end of what the process wrote on stderr, for an error message. */
	get errorOutput(): string {
		return this.stderr.trim();
	}

	private push(value: StreamJson): void {
		const waiter = this.waiter;
		if (waiter) {
			this.waiter = undefined;
			waiter(value);
		} else this.queue.push(value);
	}

	private finish(): void {
		if (this.ended) return;
		this.ended = true;
		rmSync(this.dir, { recursive: true, force: true });
		const waiter = this.waiter;
		this.waiter = undefined;
		waiter?.(undefined);
	}

	/** The next line, or undefined once the process has ended and every line was read. */
	next(): Promise<StreamJson | undefined> {
		const queued = this.queue.shift();
		if (queued) return Promise.resolve(queued);
		if (this.ended) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			this.waiter = resolve;
		});
	}

	send(message: Record<string, unknown>): void {
		if (this.ended) return;
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	/** Sends a control request and returns its id; its `control_response` comes back through `next()`. */
	control(request: Record<string, unknown>): string {
		const id = `prism-${++this.requestCounter}`;
		this.send({ type: "control_request", request_id: id, request });
		return id;
	}

	kill(): void {
		if (this.ended) return;
		this.child.stdin.end();
		this.child.kill("SIGTERM");
		const hard = setTimeout(() => this.child.kill("SIGKILL"), 2000);
		hard.unref();
	}
}
