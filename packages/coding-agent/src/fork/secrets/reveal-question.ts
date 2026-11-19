/**
 * the question before a key goes in where the model wrote its label
 * (reveal.ts). It names the keys and shows the command, or the file; the user answers this time, until the end of the
 * session (for this program, or this file), or always for this program, which is the `passEnv` rule that also passes
 * a variable to that program's environment. A rule already there answers without a question. Without anyone to
 * answer (print mode, a scheduled run), the call is refused. The extension runs after the permission gate, which
 * judges the command with its labels.
 *
 * fork.12 (security audit, AS-014): a file that received a key is hidden from the agent until the end of the session
 * (key-files.ts); the question says so, and the file tools that would read it are refused here.
 */

import { relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "../../core/extensions/types.ts";
import { resolveReadPath, resolveToCwd } from "../../core/tools/path-utils.ts";
import { fill, t } from "../i18n/index.ts";
import { own } from "../own.ts";
import { sessionSandbox } from "../sandbox/runtime.ts";
import { knownSecrets, passRuleMatches, readSecretSettings, savePassRules } from "./env.ts";
import { addKeyFile, forgetKeyFiles, keyFileAt } from "./key-files.ts";
import { secretLabel } from "./mask.ts";
import { approveReveal, forgetReveal, type LabelProblem, labelNames, lookUpLabels } from "./reveal.ts";

type Target = { kind: "command"; command: string } | { kind: "file"; path: string; texts: string[] };

/** Where the call may hold labels: a command (bash, a background task) or a file's new text (write, edit). */
function targetOf(toolName: string, input: Record<string, unknown>): Target | undefined {
	if (
		(toolName === "bash" || (toolName === "background" && input.action === "run")) &&
		typeof input.command === "string"
	)
		return { kind: "command", command: input.command };
	if (typeof input.path !== "string") return undefined;
	if (toolName === "write" && typeof input.content === "string")
		return { kind: "file", path: input.path, texts: [input.content] };
	if (toolName === "edit" && Array.isArray(input.edits)) {
		const texts = input.edits.flatMap((edit: unknown) =>
			typeof edit === "object" && edit !== null
				? [(edit as { oldText?: unknown }).oldText, (edit as { newText?: unknown }).newText].filter(
						(text): text is string => typeof text === "string",
					)
				: [],
		);
		return { kind: "file", path: input.path, texts };
	}
	return undefined;
}

/** The rule "always for this program", `bash(curl *)`, when the command is one program that a rule can cover. */
export function programRule(tool: string, command: string): string | undefined {
	const program = command.trim().split(/\s+/, 1)[0] ?? "";
	if (!/^[\w.+/-]+$/.test(program)) return undefined;
	const rule = `${tool}(${program} *)`;
	return passRuleMatches(rule, tool, command) ? rule : undefined;
}

/** Said to the model, in English like the other notes. */
const PROBLEMS: Record<LabelProblem, (name: string) => string> = {
	"several keys": (name) => `Several keys are named ${name}: Prism cannot tell which one to put in. Ask the user.`,
	"unsafe in a command": (name) =>
		`The key ${name} holds characters a shell reads differently (a quote, a space, $…): Prism does not put it in a command. Ask the user.`,
};

const its = (names: readonly string[]) => (names.length === 1 ? "its value" : "their values");

/**
 * fork.12 (AS-014): why a file tool may not read a file that received a key in this session, or undefined. `edit`
 * passes when it names each of the file's keys by its label: it then reads the file with them as labels (reveal.ts).
 */
function keyFileRefusal(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	target: Target | undefined,
	approved: ReadonlySet<string>,
): string | undefined {
	const input = event.input as Record<string, unknown>;
	const tool = event.toolName;
	if (tool !== "read" && tool !== "grep" && tool !== "edit") return undefined;
	const raw = typeof input.path === "string" && input.path ? input.path : tool === "grep" ? "." : undefined;
	if (raw === undefined) return undefined;
	const found = keyFileAt(
		ctx.sessionManager,
		tool === "read" ? resolveReadPath(raw, ctx.cwd) : resolveToCwd(raw, ctx.cwd),
	);
	if (!found) return undefined;
	const name = relative(ctx.cwd, found.file).startsWith("..") ? found.file : relative(ctx.cwd, found.file);
	const hidden = `${name} received a key in this session (Prism wrote it there with the user's leave), so it is hidden from you until the session ends: from the file tools and from your commands. Do not try to read it another way.`;
	if (tool === "grep") return `${hidden} Search a folder that does not hold it.`;
	if (tool === "read") return hidden;
	if (target?.kind === "file" && [...found.names].every((key) => approved.has(key))) return undefined;
	return `${hidden} To change it, write the label of each key it holds (${[...found.names].map(secretLabel).join(", ")}) in your edit, or write the whole file again.`;
}

/** fork.12 (AS-014): the files this session's earlier calls wrote a key into, hidden again when it is resumed. */
function restoreKeyFiles(ctx: ExtensionContext): void {
	forgetKeyFiles(ctx.sessionManager);
	const failed = new Set<string>();
	const calls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult" && message.isError) failed.add(message.toolCallId);
		else if (message.role === "assistant")
			for (const part of message.content) if (part.type === "toolCall") calls.push(part);
	}
	let secrets: ReturnType<typeof knownSecrets> | undefined;
	for (const call of calls) {
		const target = failed.has(call.id) ? undefined : targetOf(call.name, call.arguments);
		if (target?.kind !== "file") continue;
		const names = labelNames(target.texts);
		if (names.length === 0) continue;
		secrets ??= knownSecrets();
		const keys = [...lookUpLabels(names, secrets, false).keys.keys()];
		if (keys.length > 0) addKeyFile(ctx.sessionManager, resolveToCwd(target.path, ctx.cwd), keys);
	}
}

export function registerKeyQuestion(pi: ExtensionAPI): void {
	/** `name\0scope`: what the user allowed until the end of the session, scope being a program rule or a file. */
	const forSession = new Set<string>();
	// Calls can be prepared in parallel; one question must not hide another.
	let waiting: Promise<void> = Promise.resolve();

	async function ask(event: ToolCallEvent, ctx: ExtensionContext, title: string, options: string[]) {
		const previous = waiting;
		let release = () => {};
		waiting = new Promise<void>((done) => {
			release = done;
		});
		await previous;
		try {
			return await ctx.ui.select(title, options, { signal: ctx.signal, toolCallId: event.toolCallId });
		} finally {
			release();
		}
	}

	pi.on("tool_call", async (event, ctx) => {
		const target = targetOf(event.toolName, event.input as Record<string, unknown>);
		const texts = target === undefined ? [] : target.kind === "command" ? [target.command] : target.texts;
		const names = labelNames(texts);
		const lookup = names.length > 0 ? lookUpLabels(names, knownSecrets(), target?.kind === "command") : undefined;
		const refusal = keyFileRefusal(event, ctx, target, new Set(lookup?.keys.keys()));
		if (refusal) return { block: true, reason: refusal };
		if (!target || !lookup) return;
		const problem = [...lookup.problems][0];
		if (problem) return { block: true, reason: PROBLEMS[problem[1]](problem[0]) };
		const wanted = [...lookup.keys.keys()];
		if (wanted.length === 0) return;

		const rule = target.kind === "command" ? programRule(event.toolName, target.command) : undefined;
		const scope = target.kind === "command" ? rule : `file:${resolve(ctx.cwd, target.path)}`;
		const passEnv = readSecretSettings().passEnv;
		const toAsk = wanted.filter(
			(name) =>
				!(scope && forSession.has(`${name}\0${scope}`)) &&
				!(
					target.kind === "command" &&
					(own(passEnv, name) ?? []).some((candidate) =>
						passRuleMatches(candidate, event.toolName, target.command),
					)
				),
		);
		if (toAsk.length > 0) {
			const list = toAsk.join(", ");
			if (!ctx.hasUI) {
				return {
					block: true,
					reason: `Prism puts ${list} in only after asking the user, and no one can answer here. Do not look for ${its(toAsk)} another way.`,
				};
			}
			const once = t("Yes, this time");
			const session =
				target.kind === "file"
					? t("Yes, for this file until the end of the session")
					: rule
						? fill("Yes, for {0} until the end of the session", rule)
						: undefined;
			const always = rule ? fill("Yes, always for {0}", rule) : undefined;
			const no = t("No");
			// fork.12 (AS-014): what the agent can do with the file afterwards. Without a sandbox, its commands can read it.
			const title =
				target.kind === "command"
					? `${fill("The agent wants to use {0} in this command. Prism puts the key in when it runs; the agent never sees it.", list)}\n\n${target.command}`
					: fill(
							sessionSandbox(ctx.sessionManager)
								? "The agent wants to write {0} into {1}. Prism puts the key in when it writes; the agent never sees it, and {1} is then hidden from the agent until the end of the session."
								: "The agent wants to write {0} into {1}. Prism puts the key in when it writes and hides {1} from the agent's file tools until the end of the session; its commands, which run without the sandbox, can read it.",
							list,
							target.path,
						);
			const options = [once, session, always, no].filter((option): option is string => option !== undefined);
			const answer = await ask(event, ctx, title, options);
			if (answer === undefined || answer === no || !options.includes(answer)) {
				return {
					block: true,
					reason: `The user did not let you use ${list} here. Do not look for ${its(toAsk)} another way.`,
				};
			}
			if (answer === session && scope) for (const name of toAsk) forSession.add(`${name}\0${scope}`);
			if (answer === always && rule) {
				try {
					for (const name of toAsk) {
						const rules = own(readSecretSettings().passEnv, name) ?? [];
						if (!rules.includes(rule)) savePassRules(name, [...rules, rule]);
					}
				} catch (error) {
					// The answer holds for this call; only the rule could not be kept.
					ctx.ui.notify(
						fill("Could not save the rule: {0}", error instanceof Error ? error.message : String(error)),
						"warning",
					);
				}
			}
		}
		// Before the write: a command prepared in parallel must already find the file hidden.
		if (target.kind === "file")
			addKeyFile(ctx.sessionManager, resolveToCwd(target.path, ctx.cwd), lookup.keys.keys());
		approveReveal(event.toolCallId, lookup.keys);
		return undefined;
	});
	pi.on("tool_result", (event) => {
		forgetReveal(event.toolCallId);
	});
	pi.on("session_start", (_event, ctx) => {
		forSession.clear();
		forgetReveal();
		restoreKeyFiles(ctx);
	});
}
