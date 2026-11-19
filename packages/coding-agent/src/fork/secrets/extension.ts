/**
 * fork: what the model and the user are told about the secrets kept out of the model's
 * commands (env.ts), and the masking of known secrets in tool results. Registered as an inline extension
 * that is not `builtin`, as the permission gate, so --no-extensions, --safe and the `extensions` setting
 * keep it loaded.
 *
 * - A command that uses a removed variable ends with a line naming it, never its value, and saying the user
 *   decides. The names appear nowhere else for the model: the system prompt does not list them
 *   , so the environment is not revealed without need.
 * - A known secret (a stored key, a removed variable's value) is replaced by its name in every tool
 *   result, before the model, the session file or an export sees it.
 * - /settings › Permissions & sandbox lists the removed variables and the user's rules passing one to a
 *   command, and moves the credentials still in clear to the
 *   keyring.
 */

import { setDebugTextFilter } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { fill, t } from "../i18n/index.ts";
import { scheduledRun } from "../scheduled-tasks.ts";
import type { ListEntry } from "../settings-list-editor.ts";
import { paged, withPage } from "../settings-pages.ts";
import { setSettingsSection, settingsSections } from "../settings-sections.ts";
import {
	ALLOW_ENV_NAME,
	commandEnv,
	knownSecrets,
	type RemovalReason,
	readSecretSettings,
	saveAllowEnv,
	saveEnvAllowlist,
	savePassRules,
	secretVariables,
	storedSecrets,
	unlistedVariables,
} from "./env.ts";
import { onKeyringWarning } from "./keyring.ts";
import { maskText, maskValue, secretLabel } from "./mask.ts";
import { credentialsInClear, migrateToKeyring } from "./migration.ts";
import { MigrationPage, migrationSettingsPage } from "./migration-page.ts";
import { labelNames } from "./reveal.ts";
import { registerKeyQuestion } from "./reveal-question.ts";

const SETTINGS_OWNER = "secrets";

const REASONS: Record<RemovalReason, string> = {
	name: "hidden · its name",
	agent: "hidden · identity agent",
	"stored key": "hidden · holds a stored key",
	address: "hidden · its address holds a password",
};

const removedNames = () => [
	...new Set([
		...secretVariables(process.env, storedSecrets()).map(({ name }) => name),
		...unlistedVariables(process.env, readSecretSettings()),
	]),
];

/** Programs that read secret variables on their own, by the variables' prefixes; any other program reads `<NAME>_*`. */
const CONSUMERS: Record<string, readonly string[]> = {
	gh: ["GH_", "GITHUB_"],
	glab: ["GITLAB_", "GLAB_"],
	hf: ["HF_", "HUGGING_FACE_"],
	"huggingface-cli": ["HF_", "HUGGING_FACE_"],
	npm: ["NPM_"],
	npx: ["NPM_"],
	pnpm: ["NPM_", "PNPM_"],
	yarn: ["NPM_", "YARN_"],
	ssh: ["SSH_"],
	scp: ["SSH_"],
	sftp: ["SSH_"],
	rsync: ["SSH_"],
	gpg: ["GPG_"],
};
// Git reads the SSH agent only to reach a remote.
const GIT_REMOTE = /^git\s+(?:push|pull|fetch|clone|ls-remote|submodule|remote\s+update)\b|git@[\w.-]+:|ssh:\/\//;

/** The programs a command runs: the first word of each part, without assignments, sudo, env or a path. */
function commandPrograms(command: string): string[] {
	return command
		.split(/&&|\|\||[;|\n&()]/)
		.map((part) => part.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+|(?:sudo|env|time|exec|command)\s+)+/, ""))
		.map((part) => part.split(/\s+/, 1)[0]?.split("/").pop() ?? "")
		.filter((program) => /^[\w.+-]+$/.test(program));
}

/** Whether a command uses a removed variable: names it, its output names it, or a program in it reads it. */
function usesVariable(name: string, command: string, output: string): boolean {
	const word = new RegExp(`\\b${name}\\b`);
	if (new RegExp(`\\$\\{?${name}\\b`).test(command) || word.test(output)) return true;
	return commandPrograms(command).some((program) => {
		if (program === "git") return name.startsWith("SSH_") && GIT_REMOTE.test(command.trim());
		const prefixes = CONSUMERS[program] ?? [`${program.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`];
		return prefixes.some((prefix) => name.startsWith(prefix));
	});
}

/**
 * The line added to a command's result when it uses a variable removed from its environment, or undefined.
 * `removed` are the variables removed from this command (the user's rules pass the others).
 */
export function secretsResultNote(command: string, output: string, removed: readonly string[]): string | undefined {
	const used = removed.filter((name) => usesVariable(name, command, output));
	if (used.length === 0) return undefined;
	const one = used.length === 1;
	return `[Prism: ${used.join(", ")} ${one ? "is" : "are"} removed from your commands' environment, which may be why this command failed. This is intended. Do not look for ${one ? "its value" : "their values"} another way; ask the user, who can pass ${one ? "it" : "them"} to this command (Variables hidden from commands, /settings › Permissions & sandbox).]`;
}

const textOf = (content: readonly { type: string; text?: string }[]): string =>
	content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");

/** What the model is told the first time it sees these labels: it may write them to use the keys. */
export function labelHint(names: readonly string[]): string {
	const labels = names.map(secretLabel).join(", ");
	const one = names.length === 1;
	return `[Prism: ${labels} ${one ? "is a key" : "are keys"} hidden from you. To use ${one ? "it" : "one"} in a command (bash, background) or a file (write, edit), write the label exactly as it is: Prism asks the user, then puts the key in when it runs, without showing it to you. Do not copy or read the key another way.]`;
}

const RULE_ENTRY = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_-]+(?:\s*\(.*\))?)$/;

export default function (pi: ExtensionAPI) {
	// fork: the rendering dumps of pi-tui hold no known secret.
	setDebugTextFilter((text) => maskText(text, knownSecrets()));
	// a label the model writes in a command or a file becomes the key, after a question (reveal.ts).
	registerKeyQuestion(pi);
	/** Names whose label the model was told it can use, in this session. */
	const hinted = new Set<string>();
	pi.on("session_start", () => hinted.clear());
	pi.on("tool_result", (event) => {
		const secrets = knownSecrets();
		const command = event.toolName === "bash" || event.toolName === "background" ? event.input.command : undefined;
		const output = event.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		const note =
			typeof command === "string"
				? secretsResultNote(
						command,
						output,
						// a variable whose label the command holds went in as the key (reveal.ts), or the call was refused.
						commandEnv(process.env, event.toolName, command).removed.filter(
							(name) => !command.includes(secretLabel(name)),
						),
					)
				: undefined;
		// fork: masked on the decoded result; `maskValue` returns it unchanged when no
		// secret is in it, which says whether to answer. A search in its JSON missed a key that JSON escapes.
		const content = maskValue(event.content, secrets);
		const details = maskValue(event.details, secrets);
		const structuredContent = maskValue(event.structuredContent, secrets);
		// the first time the model sees a key's label in this session, it learns it can
		// write the label to use the key (reveal.ts); a model left to guess copied the key with sed instead. A command's
		// output is masked while it streams, so the label may already be in `event.content`; one the model wrote in
		// this call is one it already uses.
		const written = new Set(labelNames([JSON.stringify(event.input) ?? ""]));
		const fresh = labelNames([textOf(content)]).filter((name) => !written.has(name) && !hinted.has(name));
		for (const name of fresh) hinted.add(name);
		const notes = [note, fresh.length ? labelHint(fresh) : undefined].filter((text) => text !== undefined);
		if (
			notes.length === 0 &&
			content === event.content &&
			details === event.details &&
			structuredContent === event.structuredContent
		)
			return;
		return {
			content: [...content, ...notes.map((text) => ({ type: "text" as const, text: `\n${text}` }))],
			details,
			structuredContent,
		};
	});

	const entries = (): ListEntry[] => {
		const stored = storedSecrets();
		const settings = readSecretSettings();
		const secret = secretVariables(process.env, stored);
		const names = new Set(secret.map(({ name }) => name));
		return [
			...Object.entries(settings.passEnv).flatMap(([name, rules]) =>
				rules.map((rule) => ({ text: `${name} ${rule}`, tag: t("passed"), key: name })),
			),
			...secret.map(({ name, reason }) => ({
				text: name,
				tag: t(REASONS[reason]),
				fixed: true,
			})),
			// fork: with "Pass only known variables", what nothing lists is hidden too.
			...unlistedVariables(process.env, settings)
				.filter((name) => !names.has(name))
				.map((name) => ({ text: name, tag: t("hidden · not a known variable"), fixed: true })),
		];
	};

	const section = () => ({
		domain: "permissions",
		items: (context: { requestRender(): void }) => {
			const names = removedNames();
			const inClear = credentialsInClear().length;
			const allowlist = readSecretSettings().envAllowlist === true;
			return [
				{
					id: "secrets-env",
					label: "Variables hidden from commands",
					description:
						"Variables that look like keys, tokens or passwords, and identity agents such as SSH_AUTH_SOCK, are removed from the agent's commands; their values are never shown. You can pass one to a given command, as GITHUB_TOKEN bash(gh *).",
					currentValue: names.length === 0 ? "none" : `${names.length}`,
					// a page, which the Prism window draws too.
					...paged((_value, done) => ({
						kind: "list",
						list: {
							title: "Variables hidden from commands",
							description:
								"Hidden from the agent's commands (bash, background). Add a variable and the command it is passed to; Enter on a rule removes it.",
							addPrompt: "A variable and a rule, such as GITHUB_TOKEN bash(gh *)",
							entries,
							parse: (text) => {
								const match = RULE_ENTRY.exec(text.trim());
								return match
									? `${match[1]} ${match[2]}`
									: new Error(t("Type a variable, then a rule: GITHUB_TOKEN bash(gh *)."));
							},
							onAdd: (text) => {
								const [, name, rule] = RULE_ENTRY.exec(text) ?? [];
								if (!name || !rule) return;
								const rules = readSecretSettings().passEnv[name] ?? [];
								if (!rules.includes(rule)) savePassRules(name, [...rules, rule]);
							},
							onRemove: (entry) => {
								const name = entry.key ?? "";
								const rule = entry.text.slice(name.length + 1);
								savePassRules(
									name,
									(readSecretSettings().passEnv[name] ?? []).filter((candidate) => candidate !== rule),
								);
							},
							requestRender: context.requestRender,
							done: (changed) => done(changed ? "changed" : undefined),
						},
					})),
				},
				// fork: off by default; a list of secret names is a net.
				{
					id: "secrets-env-allowlist",
					label: "Pass only known variables",
					description:
						"off: the agent's commands get your environment without the variables that look like secrets. on: they get only common variables (PATH, HOME, LANG and the like), those you add below and those a rule passes, so a secret under an unusual name does not reach them. A build tool may then need its own variables added, such as JAVA_HOME.",
					currentValue: allowlist ? "on" : "off",
					values: ["on", "off"],
				},
				...(allowlist
					? [
							{
								id: "secrets-env-allowed",
								label: "Variables passed to commands",
								description:
									"Variables the agent's commands get besides the common ones, when only known variables are passed. A name, or a pattern such as CARGO_*.",
								currentValue: `${(readSecretSettings().allowEnv ?? []).length}`,
								...paged((_value: string, done: (value?: string) => void) => ({
									kind: "list" as const,
									list: {
										title: "Variables passed to commands",
										description:
											"Passed to the agent's commands besides the common variables. A variable that looks like a secret stays hidden; pass it to one command with a rule instead. Enter on a name removes it.",
										addPrompt: "A variable, or a pattern such as CARGO_*",
										entries: (): ListEntry[] =>
											(readSecretSettings().allowEnv ?? []).map((name) => ({ text: name })),
										parse: (text: string) =>
											ALLOW_ENV_NAME.test(text.trim())
												? text.trim()
												: new Error(t("Type a variable name, or a pattern such as CARGO_*.")),
										onAdd: (text: string) => {
											const names = readSecretSettings().allowEnv ?? [];
											if (!names.includes(text)) saveAllowEnv([...names, text]);
										},
										onRemove: (entry: ListEntry) =>
											saveAllowEnv(
												(readSecretSettings().allowEnv ?? []).filter((name) => name !== entry.text),
											),
										requestRender: context.requestRender,
										done: (changed: boolean) => done(changed ? "changed" : undefined),
									},
								})),
							},
						]
					: []),
				{
					id: "secrets-keyring",
					label: "Move credentials to the keyring",
					description:
						"Credentials saved in clear in auth.json before the keyring was used move to the keyring only from here, after a confirmation.",
					currentValue: inClear === 0 ? "none in clear" : fill("{0} in clear", String(inClear)),
					submenu: (_value: string, done: (value?: string) => void) =>
						new MigrationPage({
							entries: () => credentialsInClear(),
							migrate: () => migrateToKeyring(),
							requestRender: context.requestRender,
							done: (changed) => done(changed ? "changed" : undefined),
						}),
					// the window's page, with the same reads and move.
					...withPage(
						migrationSettingsPage({
							entries: () => credentialsInClear(),
							migrate: () => migrateToKeyring(),
							requestRender: context.requestRender,
						}),
					),
				},
			];
		},
		// advanced, except the move to the keyring while credentials are in clear.
		isAdvanced: (id: string) =>
			id === "secrets-env" ||
			id === "secrets-env-allowlist" ||
			id === "secrets-env-allowed" ||
			(id === "secrets-keyring" && credentialsInClear().length === 0),
		onChange: (id: string, value: string) => {
			if (id === "secrets-env-allowlist") saveEnvAllowlist(value === "on");
		},
	});

	let current: ReturnType<typeof section> | undefined;
	let stopWarnings: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		current = section();
		setSettingsSection(SETTINGS_OWNER, current);
		// Lot 2: a keyring that fails is said, never silent.
		stopWarnings?.();
		// fork.9 (CAP-01): a scheduled run has no interface; the journal keeps why its key could not be read.
		stopWarnings = onKeyringWarning((message) =>
			scheduledRun() ? process.stderr.write(`${message}\n`) : ctx.ui.notify(t(message), "warning"),
		);
	});
	pi.on("session_shutdown", () => {
		stopWarnings?.();
		stopWarnings = undefined;
		// A session started since then has put its own section in place: leave it.
		if (current && settingsSections().includes(current)) setSettingsSection(SETTINGS_OWNER, undefined);
		current = undefined;
	});
}
