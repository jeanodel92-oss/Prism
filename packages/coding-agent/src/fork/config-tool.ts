// fork: the model's only configuration writer, with a fresh, expiring user answer.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { getAgentDir } from "../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { FileSettingsStorage } from "../core/settings-manager.ts";
import { builtInExtensions } from "../extensions/index.ts";
import { AGENT_TOOLS, agentFilePath, writeAgent } from "./agents.ts";
import { configPathKind, configWriteRefusal, SECURITY_SETTING_KEYS } from "./config-policy.ts";
import { t } from "./i18n/index.ts";
import { hasInteractiveClient } from "./interactive-client.ts";
import { configurationMode } from "./permissions.ts";
import { realPath } from "./real-path.ts";

export const CONFIG_CONFIRM_TIMEOUT_MS = 120_000;
const stringList = Type.Array(Type.String());
const SETTINGS = {
	theme: Type.String(),
	animations: Type.Boolean(),
	replyLanguage: Type.String(),
	language: Type.Union([Type.Literal("auto"), Type.Literal("en"), Type.Literal("fr")]),
	interfaceMode: Type.Union([Type.Literal("simple"), Type.Literal("advanced")]),
	hideThinkingBlock: Type.Boolean(),
	showHardwareCursor: Type.Boolean(),
	editorPaddingX: Type.Integer({ minimum: 0, maximum: 10 }),
	autocompleteMaxVisible: Type.Integer({ minimum: 1, maximum: 50 }),
	defaultProvider: Type.String(),
	defaultModel: Type.String(),
	defaultThinkingLevel: Type.Union(["off", "minimal", "low", "medium", "high", "xhigh"].map((v) => Type.Literal(v))),
	defaultTools: stringList,
	enabledModels: stringList,
	extensions: stringList,
	skills: stringList,
	prompts: stringList,
	themes: stringList,
	shellPath: Type.String(),
	shellCommandPrefix: Type.String(),
	externalEditor: Type.String(),
	npmCommand: stringList,
};

const isOptionalModule = (name: string) =>
	builtInExtensions.some(
		(entry) =>
			typeof entry !== "function" && entry.builtin && entry.name === name && entry.name !== "module-cost-probe",
	);

const changeSchema = Type.Union([
	Type.Object(
		{ action: Type.Literal("setting"), key: Type.String(), value: Type.Unknown() },
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("module"), name: Type.String(), enabled: Type.Boolean() },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("agent"),
			name: Type.String(),
			description: Type.String(),
			model: Type.Optional(Type.String()),
			tools: Type.Array(Type.Union(AGENT_TOOLS.map((name) => Type.Literal(name))), { minItems: 1 }),
			instructions: Type.String(),
		},
		{ additionalProperties: false },
	),
]);

// fork: providers expect an object at the schema root; the union validates each action at runtime.
const parameters = Type.Object(
	{
		action: Type.Union([Type.Literal("setting"), Type.Literal("module"), Type.Literal("agent")]),
		key: Type.Optional(Type.String()),
		value: Type.Optional(Type.Unknown()),
		name: Type.Optional(Type.String()),
		enabled: Type.Optional(Type.Boolean()),
		description: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		tools: Type.Optional(Type.Array(Type.Union(AGENT_TOOLS.map((name) => Type.Literal(name))))),
		instructions: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

/** fork: the persisted Plan state applies even if its tool picker admits this tool. */
function readOnly(ctx: ExtensionContext): boolean {
	const entry = ctx.sessionManager
		.getBranch()
		.findLast((entry) => entry.type === "custom" && entry.customType === "plan-mode-state");
	return entry?.type === "custom" && (entry.data as { enabled?: unknown } | undefined)?.enabled === true;
}

export default function configTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "configure_prism",
		label: t("Configure Prism"),
		permissions: ["fs.write"],
		description:
			"Change a supported global Prism setting, toggle a built-in module, or create/replace a custom agent. Always asks the user for this change only (120-second timeout). TUI only; refused in safe/Plan mode, print and RPC. Cannot change permissions, sandbox, trust, secrets, credentials or models.json. Settings and modules apply after /reload or restart; agents apply on their next use.",
		promptSnippet: "Change Prism settings, modules or custom agents after user confirmation",
		promptGuidelines: [
			"Use configure_prism alone for configuration changes; never write, edit or bash configuration files. Read docs/permissions.md for the supported settings. Do not retry a refused change through another tool.",
			"Security settings belong to the user: permissions and mode, sandbox and network policy, trusted folders, secrets and credentials are never configurable by this tool. Code-running changes need careful review of the displayed risk.",
		],
		parameters,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const checkMode = () => {
				const mode = configurationMode(ctx);
				if (mode === undefined || mode === "safe")
					throw new Error("Configuration changes are refused in safe mode.");
				if (readOnly(ctx)) throw new Error("Configuration changes are refused in read-only mode.");
			};
			// fork: RPC advertises hasUI even without a client that can answer its dialogs.
			if (!hasInteractiveClient(ctx))
				throw new Error(
					"Configuration changes need the user at the terminal or the Prism window. Print, scheduled runs and RPC clients without dialogs are refused.",
				);
			checkMode();
			if (!Check(changeSchema, params)) throw new Error("Invalid configuration change.");
			const agentDir = getAgentDir();
			let file = join(agentDir, "settings.json");
			let key: string;
			let value: unknown;
			let risk = false;
			if (params.action === "setting") {
				if ((SECURITY_SETTING_KEYS as readonly string[]).includes(params.key))
					throw new Error(configWriteRefusal("security"));
				const schema = SETTINGS[params.key as keyof typeof SETTINGS];
				if (!Object.hasOwn(SETTINGS, params.key) || !schema || !Check(schema, params.value))
					throw new Error("Unsupported setting or invalid value. See docs/permissions.md.");
				// the model may switch Prism's own modules, never load a package or file.
				if (
					params.key === "extensions" &&
					!(params.value as string[]).every((entry) => {
						const name = /^[+!-]?builtin:(.+)$/.exec(entry)?.[1];
						return name !== undefined && isOptionalModule(name);
					})
				)
					throw new Error(
						"Only Prism's built-in modules can be set here (builtin:<name>). Add other extensions as the user.",
					);
				key = params.key;
				value = params.value;
				risk = [
					"extensions",
					"shellPath",
					"shellCommandPrefix",
					"externalEditor",
					"npmCommand",
					"defaultTools",
				].includes(key);
			} else if (params.action === "module") {
				if (!isOptionalModule(params.name)) throw new Error("Unknown optional module.");
				key = "extensions";
				risk = true;
			} else {
				file = agentFilePath(params.name, agentDir);
				if (!params.description.trim()) throw new Error("Purpose cannot be empty.");
				key = params.name;
				risk = params.tools.some((name) => name === "bash" || name === "write" || name === "edit");
				value = { ...params, action: undefined };
			}
			const checkPath = () => {
				if (configPathKind(file, ctx.cwd) === "security") throw new Error(configWriteRefusal("security"));
				const expected =
					params.action === "agent"
						? join(realPath(agentDir), "agents", `${params.name}.md`)
						: join(realPath(agentDir), "settings.json");
				if (realPath(file) !== expected)
					throw new Error("Configuration links are refused. Change the file directly as the user.");
			};
			checkPath();
			const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
			const settings: unknown = params.action === "agent" ? {} : before === undefined ? {} : JSON.parse(before);
			if (!settings || typeof settings !== "object" || Array.isArray(settings))
				throw new Error("Invalid configuration file.");
			const current = settings as Record<string, unknown>;
			if (params.action === "module") {
				if (current.extensions !== undefined && !Check(stringList, current.extensions))
					throw new Error("Invalid configuration file.");
				const path = `builtin:${params.name}`;
				value = [
					...((current.extensions ?? []) as string[]).filter((entry) => entry.replace(/^[+!-]/, "") !== path),
					`${params.enabled ? "+" : "-"}${path}`,
				];
			}
			const old = params.action === "agent" ? before : current[key];
			const title = [
				t("Change Prism configuration?"),
				file,
				`${key}: ${JSON.stringify(old) ?? t("(unset)")} -> ${JSON.stringify(value)}`,
				risk
					? t(
							"Risk: this can run code through extensions, hooks, shell commands or agent tools. Review it before allowing.",
						)
					: "",
				t("Settings and modules apply after /reload or restart. Agents apply on their next use."),
			]
				.filter(Boolean)
				.join("\n\n");
			const controller = new AbortController();
			const cancel = () => controller.abort();
			signal?.addEventListener("abort", cancel, { once: true });
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const answer = await Promise.race([
					ctx.ui.select(title, [t("Allow this change once"), t("Refuse this change")], {
						timeout: CONFIG_CONFIRM_TIMEOUT_MS,
						signal: controller.signal,
					}),
					new Promise<undefined>((resolve) => {
						timer = setTimeout(() => {
							controller.abort();
							resolve(undefined);
						}, CONFIG_CONFIRM_TIMEOUT_MS);
					}),
				]);
				if (signal?.aborted || controller.signal.aborted || answer !== t("Allow this change once"))
					throw new Error(
						"Configuration change refused or unanswered. Nothing changed. Do not retry through another tool.",
					);
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", cancel);
			}
			checkMode();
			checkPath();
			if (params.action === "agent") {
				if ((existsSync(file) ? readFileSync(file, "utf8") : undefined) !== before)
					throw new Error("Configuration changed while waiting. Nothing saved.");
				writeAgent(params, agentDir);
			} else {
				new FileSettingsStorage(ctx.cwd, agentDir).withLock("global", (latest) => {
					checkPath();
					if (latest !== before) throw new Error("Configuration changed while waiting. Nothing saved.");
					return `${JSON.stringify({ ...current, [key]: value }, null, 2)}\n`;
				});
			}
			return {
				content: [
					{
						type: "text",
						text: "Configuration saved. Settings and modules apply after /reload or restart; agents apply on their next use.",
					},
				],
				details: { changed: true },
			};
		},
		// fork: the model reads the English text; the user reads it in the interface language.
		renderResult(result, _options, theme) {
			const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
			return new Text(theme.fg("toolOutput", t(text)), 0, 0);
		},
	});
}
