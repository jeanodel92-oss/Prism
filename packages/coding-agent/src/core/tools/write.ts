import type { AgentTool } from "@earendil-works/pi-agent-core";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import { anchoredOpenSupported, publishFile } from "../../fork/anchored-open.ts";
import { takeFileBinding, writeBound } from "../../fork/file-binding.ts";
import { realPath, symlinkTarget } from "../../fork/real-path.ts";
import { assertNotSpecialFile } from "../../fork/regular-file.ts";
import { revealSecrets } from "../../fork/secrets/reveal.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { writeRenderers } from "./renderers/write.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export const writeToolSystemPromptContribution = {
	snippet: "Create or overwrite files",
	guidelines: ["Use write only for new files or complete rewrites."],
} as const;

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
	// fork: opening a FIFO for writing blocks until a reader shows up.
	// fork: an existing file is replaced by a complete new version when it can.
	writeFile: (path, content) =>
		assertNotSpecialFile(path).then(() =>
			anchoredOpenSupported ? publishFile(realPath(path), content) : fsWriteFile(path, content, "utf-8"),
		),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, undefined> {
	const ops = options?.operations ?? defaultWriteOperations;
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: writeToolSystemPromptContribution.snippet,
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		parameters: writeSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
			const dir = dirname(absolutePath);
			// fork: open the object the permission judged, through no link put since.
			const binding = ops === defaultWriteOperations ? takeFileBinding(_toolCallId, absolutePath) : undefined;
			return withFileMutationQueue(binding?.physical ?? absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				// the keys the user let this call use, in place of their labels (secrets/reveal.ts).
				content = revealSecrets(_toolCallId, content);
				// Create parent directories if needed.
				if (binding) writeBound(binding, content);
				else await ops.mkdir(dir);
				throwIfAborted();

				// Write the file contents.
				if (!binding) await ops.writeFile(absolutePath, content);
				throwIfAborted();

				// fork: say where the bytes went when a symlink led out of the named path.
				const target = ops === defaultWriteOperations ? symlinkTarget(absolutePath, ctx?.cwd || cwd) : undefined;
				return {
					content: [
						{ type: "text", text: `Successfully wrote to ${path}${target ? ` (symlink to ${target})` : ""}` },
					],
					details: undefined,
				};
			});
		},
		...writeRenderers,
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
