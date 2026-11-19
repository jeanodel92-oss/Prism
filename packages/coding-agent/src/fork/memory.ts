/**
 * Manual memory.
 *
 * Never writes itself. You drive it:
 *
 *   /memory                     show what is currently remembered
 *   /memory <instruction>       have the model summarize this session into memory
 *   /memory-edit                edit the global memory file in Prism's editor dialog
 *   /memory-project <...>       same as /memory but scoped to this project
 *
 * `/memory <instruction>` hands the model your instruction plus the session it
 * already has in context, and tells it to fold the result into MEMORY.md using
 * the built-in `write` tool. That means this extension registers **zero** tools
 * — the only context it ever costs is the memory file itself, appended to the
 * system prompt (identically every turn, so it stays prompt-cache friendly).
 *
 *   global   <agent dir>/MEMORY.md
 *   project  <cwd>/<config dir>/MEMORY.md   (trusted projects only)
 *
 * fork: copy of fork/reference/extensions/memory.ts, shipped as the built-in extension
 * `builtin:memory`, off by default: `+builtin:memory` in the `extensions` setting turns it on.
 * Change from the reference: the global file comes from `getAgentDir()` instead of `~/.pi/agent`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import type { ExtensionAPI } from "../core/extensions/types.ts";
import { withFileMutationQueue } from "../core/tools/file-mutation-queue.ts";
import { readBoundedSync } from "./bounded-read.ts";
import { confirmCurrent } from "./confirm-current.ts";
import { lockForkFile } from "./file-lock.ts";
import { fill, t } from "./i18n/index.ts";
import { writeFileAtomicSync } from "./secrets/atomic-write.ts";

const MAX_INJECT_CHARS = 6000;

function projectMemoryPath(cwd: string) {
	return join(cwd, CONFIG_DIR_NAME, "MEMORY.md");
}

/** fork: more than is ever injected or shown; a larger file is cut, never read whole. */
const MAX_READ_BYTES = 1024 * 1024;

function read(path: string): string {
	try {
		return readBoundedSync(path, MAX_READ_BYTES, { over: "truncate" }).toString("utf8").trim();
	} catch {
		return "";
	}
}

function ensureFile(path: string) {
	mkdirSync(dirname(path), { recursive: true });
	if (!existsSync(path)) {
		writeFileSync(path, "# Memory\n\nDurable facts worth carrying between sessions. Keep entries short.\n");
	}
}

function clip(text: string, max: number) {
	return text.length > max ? `${text.slice(0, max)}\n[...memory truncated, run /memory-edit]` : text;
}

function buildInstruction(target: string, scope: string, instruction: string, current: string) {
	return [
		`Update the ${scope} memory file at ${target}.`,
		"",
		`Instruction: ${instruction}`,
		"",
		"Current contents:",
		"```markdown",
		current || "(empty)",
		"```",
		"",
		"Review this session against that instruction, then write the FULL updated file with the `write` tool.",
		"Rules: keep it short and factual; merge into existing sections instead of appending duplicates;",
		"record durable facts only (decisions, preferences, constraints, environment) — not transient task state;",
		"drop anything now contradicted; never store secrets or credentials.",
		"When done, reply with one line naming what changed.",
	].join("\n");
}

/** the memory files as the window's side menu shows them; the project's only in a trusted project. */
export function memorySnapshot(cwd: string, trusted: boolean) {
	const globalPath = join(getAgentDir(), "MEMORY.md");
	const projectPath = projectMemoryPath(cwd);
	return {
		global: { path: globalPath, text: read(globalPath) },
		project: trusted ? { path: projectPath, text: read(projectPath) } : null,
	};
}

export default function (pi: ExtensionAPI) {
	const GLOBAL_MEMORY = join(getAgentDir(), "MEMORY.md");

	// Append memory to the system prompt, identically on every turn.
	pi.on("before_agent_start", async (event, ctx) => {
		const sections: string[] = [];

		const globalMemory = read(GLOBAL_MEMORY);
		if (globalMemory) sections.push(`## Memory (global)\n${clip(globalMemory, MAX_INJECT_CHARS)}`);

		if (ctx.isProjectTrusted()) {
			const projectMemory = read(projectMemoryPath(ctx.cwd));
			if (projectMemory) {
				sections.push(`## Memory (this project)\n${clip(projectMemory, MAX_INJECT_CHARS)}`);
			}
		}

		if (sections.length === 0) return;
		// fork: a structured section, not a returned systemPrompt,
		// which would force the prompt and drop the additions of handlers that run later (append-system).
		event.systemPromptOptions.sections.memory = sections.join("\n\n");
	});

	function registerMemoryCommand(name: string, scope: "global" | "project") {
		pi.registerCommand(name, {
			description:
				scope === "global"
					? t("Show memory, or update it from this session: /memory <instruction>")
					: t("Show or update project-scoped memory: /memory-project <instruction>"),
			handler: async (args, ctx) => {
				const target = scope === "global" ? GLOBAL_MEMORY : projectMemoryPath(ctx.cwd);

				if (scope === "project" && !ctx.isProjectTrusted()) {
					ctx.ui.notify(t("Project is not trusted — project memory is disabled."), "warning");
					return;
				}

				const instruction = args.trim();
				const current = read(target);

				if (!instruction) {
					if (!current) {
						ctx.ui.notify(fill("{0} is empty. Use /{1} <instruction> to fill it.", target, name), "info");
						return;
					}
					ctx.ui.setWidget(`memory-${scope}`, current.split("\n").slice(0, 40));
					ctx.ui.notify(fill("{0} ({1} chars)", target, String(current.length)), "info");
					return;
				}

				ensureFile(target);
				ctx.ui.notify(t(scope === "global" ? "Updating global memory…" : "Updating project memory…"), "info");
				pi.sendUserMessage(buildInstruction(target, scope, instruction, current));
			},
		});
	}

	registerMemoryCommand("memory", "global");
	registerMemoryCommand("memory-project", "project");

	// fork: `pi.exec` always pipes stdio, so $EDITOR used to run with no
	// terminal (vi never exited). The editor dialog has the terminal, and its external-editor key
	// still opens $EDITOR properly.
	pi.registerCommand("memory-edit", {
		description: t("Edit the global memory file"),
		handler: async (_args, ctx) => {
			ensureFile(GLOBAL_MEMORY);
			if (!ctx.hasUI) {
				ctx.ui.notify(fill("No interface to edit memory. File: {0}", GLOBAL_MEMORY), "error");
				return;
			}
			// fork: the edited text replaces the file only while it still has
			// the text the editor opened with, checked and written under the lock of the file (this process's writes and
			// other Prisms' /memory-edit). A file changed meanwhile opens the editor again with the user's text and what
			// was saved meanwhile; it is never overwritten unseen.
			const finished = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);
			let lastEdited: string | undefined;
			let unchanged = false;
			const confirmed = await confirmCurrent(
				async (current: string, previous: string | undefined) => {
					const edited = await ctx.ui.editor(
						previous === undefined
							? fill("Global memory ({0})", GLOBAL_MEMORY)
							: fill(
									"Global memory ({0}) changed while you edited it: merge what was saved meanwhile, shown at the end, then save",
									GLOBAL_MEMORY,
								),
						previous === undefined
							? current
							: `${finished(previous)}\n${t("----- Saved meanwhile (merge what you need above, then delete from this line) -----")}\n${current}`,
					);
					if (edited === undefined) return undefined;
					// Saved without a change: nothing to write, whatever the file became meanwhile.
					if (previous === undefined && finished(edited) === finished(current)) {
						unchanged = true;
						return undefined;
					}
					lastEdited = edited;
					return edited;
				},
				() => {
					const current = readFileSync(GLOBAL_MEMORY, "utf8");
					return { value: current, version: current };
				},
				{
					changedMessage: t("Global memory changed during the edit three times in a row; it was not saved."),
					apply: async (shown, _version, edited) =>
						await withFileMutationQueue(GLOBAL_MEMORY, () =>
							lockForkFile(GLOBAL_MEMORY, () => {
								if (readFileSync(GLOBAL_MEMORY, "utf8") !== shown) return false;
								writeFileAtomicSync(GLOBAL_MEMORY, finished(edited));
								return true;
							}),
						),
				},
			).catch((error: Error) => {
				// The text is kept beside the file, never lost.
				const kept = `${GLOBAL_MEMORY}.edited-${Date.now()}`;
				if (lastEdited !== undefined) writeFileSync(kept, finished(lastEdited), { mode: 0o600 });
				ctx.ui.notify(
					lastEdited === undefined ? error.message : `${error.message} ${fill("Your text is in {0}.", kept)}`,
					"warning",
				);
				return undefined;
			});
			if (confirmed) ctx.ui.notify(t("Global memory saved."), "info");
			else if (unchanged) ctx.ui.notify(t("Global memory unchanged."), "info");
		},
	});
}
