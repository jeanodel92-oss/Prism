import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { getPiInvocation } from "./child-invocation.ts";
import { fill, t } from "./i18n/index.ts";

export interface PromptSnapshot {
	systemMessages: Array<{
		content: string;
		sections: Record<string, string | null>;
		toolsAdded: Array<{ name: string; description: string; parameters: unknown }>;
		toolsRemoved: string[];
	}>;
	rss: number;
	startupMs: number;
	children?: number;
}

export interface PromptDiff {
	changed: boolean;
	addedTokens: number;
	removedTokens: number;
	changedSections: string[];
	addedSections: string[];
	removedSections: string[];
	addedTools: string[];
	removedTools: string[];
}

export interface ModuleCostRow {
	name: string;
	prompt: PromptDiff;
	startup: string;
	memory: string;
	processes: string;
}

export interface ModuleCostReport {
	baselinePromptTokens: number;
	baselineStartupMs?: number;
	baselineMemoryMiB?: number;
	baselineProcesses?: number;
	rows: ModuleCostRow[];
}

function promptParts(snapshot: PromptSnapshot): { sections: Map<string, string>; tools: Map<string, string> } {
	const sections = new Map<string, string>();
	const tools = new Map<string, string>();
	for (const [index, message] of snapshot.systemMessages.entries()) {
		// A module can also rewrite the base text (memory returns a whole new systemPrompt).
		if (message.content) sections.set(`(base text ${index + 1})`, message.content);
		for (const [name, value] of Object.entries(message.sections)) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
		for (const tool of message.toolsAdded) tools.set(tool.name, JSON.stringify(tool));
		for (const name of message.toolsRemoved) tools.delete(name);
	}
	return { sections, tools };
}

/** Tokens of the lines only in `after` (added) and only in `before` (removed), as multisets. */
function lineDelta(before: string, after: string): { added: number; removed: number } {
	const counts = new Map<string, number>();
	for (const line of before.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
	let added = 0;
	for (const line of after.split("\n")) {
		const left = counts.get(line) ?? 0;
		if (left > 0) counts.set(line, left - 1);
		else added += estimateTextTokens(line);
	}
	let removed = 0;
	for (const [line, left] of counts) removed += left * estimateTextTokens(line);
	return { added, removed };
}

// A section that changes by one line (the tool list) costs that line, not the whole section twice.
function changedTokenCounts(
	before: Map<string, string>,
	after: Map<string, string>,
): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const name of new Set([...before.keys(), ...after.keys()])) {
		const delta = lineDelta(before.get(name) ?? "", after.get(name) ?? "");
		added += delta.added;
		removed += delta.removed;
	}
	return { added, removed };
}

export function diffPrompt(before: PromptSnapshot, after: PromptSnapshot): PromptDiff {
	const beforeParts = promptParts(before);
	const afterParts = promptParts(after);
	const sections = changedTokenCounts(beforeParts.sections, afterParts.sections);
	const tools = changedTokenCounts(beforeParts.tools, afterParts.tools);
	const addedTools = [...afterParts.tools.keys()].filter((name) => !beforeParts.tools.has(name));
	const removedTools = [...beforeParts.tools.keys()].filter((name) => !afterParts.tools.has(name));
	const changedSections = [...new Set([...beforeParts.sections.keys(), ...afterParts.sections.keys()])].filter(
		(name) => beforeParts.sections.get(name) !== afterParts.sections.get(name),
	);
	const addedSections = [...afterParts.sections.keys()].filter((name) => !beforeParts.sections.has(name));
	const removedSections = [...beforeParts.sections.keys()].filter((name) => !afterParts.sections.has(name));
	return {
		changed: sections.added + sections.removed + tools.added + tools.removed > 0,
		addedTokens: sections.added + tools.added,
		removedTokens: sections.removed + tools.removed,
		changedSections,
		addedSections,
		removedSections,
		addedTools,
		removedTools,
	};
}

export function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function formatNoisyDelta(before: number[], after: number[], unit: "ms" | "MiB"): string {
	const beforeMedian = median(before);
	const afterMedian = median(after);
	if (beforeMedian === undefined || afterMedian === undefined) return t("unknown");
	const spread = Math.max(Math.max(...before) - Math.min(...before), Math.max(...after) - Math.min(...after));
	const delta = afterMedian - beforeMedian;
	return Math.abs(delta) < spread
		? fill(unit === "ms" ? "below noise (±{0} ms)" : "below noise (±{0} MiB)", formatNumber(spread))
		: fill(unit === "ms" ? "{0} ms" : "{0} MiB", `${delta > 0 ? "+" : ""}${formatNumber(delta)}`);
}

export function formatProcessDelta(
	before: Array<number | undefined>,
	after: Array<number | undefined>,
	platform = process.platform,
): string {
	if (
		platform !== "linux" ||
		before.some((value) => value === undefined) ||
		after.some((value) => value === undefined)
	) {
		return t("unknown");
	}
	const delta = (median(after as number[]) ?? 0) - (median(before as number[]) ?? 0);
	return `${delta > 0 ? "+" : ""}${delta}`;
}

function formatNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function promptTotal(snapshot: PromptSnapshot): number {
	const parts = promptParts(snapshot);
	return (
		[...parts.sections.values()].reduce((sum, value) => sum + estimateTextTokens(value), 0) +
		[...parts.tools.values()].reduce((sum, value) => sum + estimateTextTokens(value), 0)
	);
}

function runProbe(
	agentDir: string,
	home: string,
	cwd: string,
	outputPath: string,
	signal: AbortSignal,
): Promise<PromptSnapshot> {
	const invocation = getPiInvocation(["--no-session", "--model", "prism-module-cost/probe", "-p", "hi"]);
	return new Promise((resolve, reject) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd,
			detached: process.platform !== "win32",
			stdio: ["ignore", "ignore", "pipe"],
			env: {
				PATH: process.env.PATH ?? "",
				TMPDIR: tmpdir(),
				HOME: home,
				PI_CODING_AGENT_DIR: agentDir,
				PRISM_CODING_AGENT_DIR: agentDir,
				PI_OFFLINE: "1",
				PRISM_MODULE_COST_OUT: outputPath,
			},
		});
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		const onAbort = () => {
			if (process.platform !== "win32" && child.pid !== undefined) {
				try {
					process.kill(-child.pid, "SIGTERM");
					return;
				} catch {
					child.kill("SIGTERM");
					return;
				}
			}
			child.kill("SIGTERM");
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		child.once("error", (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.once("close", async (code) => {
			signal.removeEventListener("abort", onAbort);
			if (signal.aborted) return reject(new Error("Measurement cancelled"));
			if (code !== 0) return reject(new Error(stderr.trim() || `Probe exited with code ${code}`));
			try {
				resolve(JSON.parse(await readFile(outputPath, "utf8")) as PromptSnapshot);
			} catch (error) {
				reject(error);
			}
		});
	});
}

/**
 * fork: a global extension entry as it names the same files from the probe's own
 * agent dir and HOME. The loader reads a path relative to the agent dir, and `~` from HOME; copied unchanged into the
 * probe's profile, `./custom.ts` named a file that is not there and the measure ran without it. A pattern that names
 * no folder still matches by file name, and a built-in is no path: both stay as they are.
 */
function rebasedEntry(entry: string, agentDir: string): string {
	const prefix = /^[+!-]/u.test(entry) ? entry[0] : "";
	const body = entry.slice(prefix.length);
	if (body.startsWith("builtin:")) return entry;
	const pattern = prefix !== "" || body.includes("*") || body.includes("?");
	if (pattern && (!body.includes("/") || body.startsWith("*"))) return entry;
	return prefix + resolvePath(body, agentDir, { homeDir: process.env.HOME || homedir(), trim: true });
}

export async function measureModuleCosts(options: {
	modules: Array<{ name: string; enabled: boolean }>;
	globalExtensions: string[];
	selected: string | "all";
	signal: AbortSignal;
	onProgress: (index: number, total: number, module: string) => void;
}): Promise<ModuleCostReport> {
	const modules =
		options.selected === "all" ? options.modules : options.modules.filter(({ name }) => name === options.selected);
	const root = await mkdtemp(join(tmpdir(), "prism-module-cost-"));
	const cwd = join(root, "cwd");
	const realAgentDir = getAgentDir();
	const globalExtensions = options.globalExtensions.map((entry) => rebasedEntry(entry, realAgentDir));
	const baseline: PromptSnapshot[] = [];
	const rows: ModuleCostRow[] = [];
	try {
		await mkdir(cwd);
		for (let index = 0; index < modules.length; index++) {
			if (options.signal.aborted) throw new Error("Measurement cancelled");
			const module = modules[index]!;
			options.onProgress(index + 1, modules.length, module.name);
			// One agent dir and HOME for both states: paths end up in the prompt (skill locations).
			const agentDir = join(root, "agent");
			const home = join(root, "home");
			const output = join(root, "request.json");
			const entries = globalExtensions.filter((entry) => entry.replace(/^[+!-]/u, "") !== `builtin:${module.name}`);
			// fork: both states written out. The session's state can come from the
			// project's settings, which the probe does not copy: with `-builtin:x` global and `+builtin:x` in the project,
			// the global list and its "flip" were both off.
			const onEntries = [...entries, `+builtin:${module.name}`];
			const offEntries = [...entries, `-builtin:${module.name}`];
			await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(home, { recursive: true })]);
			const probe = async (extensions: string[]) => {
				await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions }));
				return runProbe(agentDir, home, cwd, output, options.signal);
			};
			const active: PromptSnapshot[] = [];
			const inactive: PromptSnapshot[] = [];
			for (let run = 0; run < 3; run++) {
				(module.enabled ? active : inactive).push(await probe(module.enabled ? onEntries : offEntries));
				(module.enabled ? inactive : active).push(await probe(module.enabled ? offEntries : onEntries));
			}
			// The baseline is the session's own state of the module.
			baseline.push(...(module.enabled ? active : inactive));
			const prompt = diffPrompt(inactive[1]!, active[1]!);
			const activeChildren = active.map(({ children }) => children);
			const inactiveChildren = inactive.map(({ children }) => children);
			rows.push({
				name: module.name,
				prompt,
				startup: formatNoisyDelta(
					inactive.map(({ startupMs }) => startupMs),
					active.map(({ startupMs }) => startupMs),
					"ms",
				),
				memory: formatNoisyDelta(
					inactive.map(({ rss }) => rss / 1024 / 1024),
					active.map(({ rss }) => rss / 1024 / 1024),
					"MiB",
				),
				processes: formatProcessDelta(inactiveChildren, activeChildren),
			});
		}
		return {
			baselinePromptTokens: baseline.length ? promptTotal(baseline[0]!) : 0,
			baselineStartupMs: median(baseline.map(({ startupMs }) => startupMs)),
			baselineMemoryMiB: median(baseline.map(({ rss }) => rss / 1024 / 1024)),
			baselineProcesses: baseline.some(({ children }) => children === undefined)
				? undefined
				: median(baseline.map(({ children }) => children!)),
			rows,
		};
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
