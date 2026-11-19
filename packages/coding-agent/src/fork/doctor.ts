/** fork: local, read-only diagnostics available through /doctor. */
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
	type Component,
	getKeybindings,
	sanitizeTerminalLabel,
	sanitizeTerminalText,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { CONFIG_DIR_NAME, getAgentDir, getModelsPath, getSettingsPath } from "../config.ts";
import { readCrashLog } from "../core/crash-log.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { ModelConfig } from "../core/model-config.ts";
import { resolveToCwd } from "../core/tools/path-utils.ts";
import type { Theme } from "../modes/interactive/theme/theme.ts";
import { stripJsonComments } from "../utils/json.ts";
import { normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { capabilitiesPath, readCapabilities } from "./capability-store.ts";
import { getExtensionLoadDiagnostics, getLastModelFailure } from "./doctor-diagnostics.ts";
import { fill, t } from "./i18n/index.ts";
import { isKeyringMarker, keyringEnabled, keyringState } from "./secrets/keyring.ts";

export interface DoctorCheck {
	component: string;
	status: "ok" | "problem" | "not tested";
	observed: string;
	cause: string;
	action: string;
	detail: string;
}

export interface DoctorReport {
	createdAt: string;
	checks: DoctorCheck[];
}

function redact(value: string): string {
	const home = homedir();
	return value
		.replaceAll(home, "~")
		.replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
		.replace(/([?&](?:api[_-]?key|token|secret|authorization|key)=)[^&#\s]+/gi, "$1[redacted]")
		.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
		.replace(/((?:api[_-]?key|token|secret|authorization)\s*(?:[=:]|is)\s*)[^\s,;"']+/gi, "$1[redacted]")
		.replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[redacted]");
}

function check(
	component: string,
	status: DoctorCheck["status"],
	observed: string,
	cause: string,
	action: string,
	detail = observed,
): DoctorCheck {
	return {
		component: t(component),
		status,
		observed: t(observed),
		cause: t(cause),
		action: t(action),
		detail: redact(detail),
	};
}

function checkJsonFile(path: string, label: string, required = false): DoctorCheck {
	if (!existsSync(path)) {
		return check(
			label,
			required ? "problem" : "ok",
			required ? "File is missing." : "File is not present; defaults apply.",
			required ? "Confirmed: required file is missing." : "Confirmed: the file is optional and absent.",
			required ? "Create the file or remove the reference to it." : "No action required.",
			path,
		);
	}
	try {
		JSON.parse(stripBom(readFileSync(path, "utf8")));
		return check(
			label,
			"ok",
			"File parses as JSON.",
			"Confirmed: JSON parsing succeeded.",
			"No action required.",
			path,
		);
	} catch (error) {
		const detail = error instanceof Error ? error.name : "SyntaxError";
		return check(
			label,
			"problem",
			"File could not be parsed.",
			"Confirmed: JSON parsing failed.",
			"Fix the JSON syntax, then run /doctor again.",
			`${path}: ${detail}`,
		);
	}
}

/** fork: where the credentials are kept, and whether the keyring failed (never a silent fallback). */
function keyringCheck(agentDir: string): DoctorCheck {
	const authPath = normalizePath(join(agentDir, "auth.json"));
	let data: unknown = {};
	try {
		data = JSON.parse(stripBom(readFileSync(authPath, "utf8")));
	} catch {
		// No auth.json, or not JSON (its own check reports that): no credential to place.
	}
	const providers = typeof data === "object" && data !== null ? Object.entries(data) : [];
	const inKeyring = providers.filter(([, credential]) => isKeyringMarker(credential)).map(([provider]) => provider);
	const inFile = providers.filter(([, credential]) => !isKeyringMarker(credential)).map(([provider]) => provider);
	const where = `keyring: ${inKeyring.join(", ") || "-"}; auth.json: ${inFile.join(", ") || "-"}`;
	const state = keyringState(authPath);
	const failures = (failed: Map<string, string>) =>
		[...failed].map(([provider, reason]) => `${provider}: ${reason}`).join("; ");
	if (state.unreadable.size) {
		return check(
			"Keyring",
			"problem",
			"Some credentials in the keyring could not be read.",
			"Confirmed: secret-tool failed; the keyring may be locked or stopped.",
			"Unlock the keyring, then restart Prism, or log in again with /login.",
			failures(state.unreadable),
		);
	}
	if (state.refused.size) {
		return check(
			"Keyring",
			"problem",
			"Some credentials were not saved: the keyring is there but did not take them.",
			"Confirmed: secret-tool failed while saving them; the keyring may be locked or busy.",
			"Unlock the keyring, then log in again with /login.",
			failures(state.refused),
		);
	}
	if (state.fallback.size) {
		return check(
			"Keyring",
			"problem",
			"New credentials were saved in clear in auth.json because there is no keyring.",
			"Confirmed: no Secret Service on the session bus, or secret-tool is missing.",
			"Check that a Secret Service keyring (GNOME Keyring, KWallet) runs and is unlocked, then log in again with /login.",
			failures(state.fallback),
		);
	}
	if (!keyringEnabled()) {
		return check(
			"Keyring",
			inKeyring.length ? "problem" : "not tested",
			inKeyring.length
				? "Some credentials are in the keyring, which this session cannot reach."
				: "No keyring in this session: new credentials are saved in auth.json.",
			"Confirmed: no D-Bus session bus, or PRISM_SECRET_SERVICE=off.",
			"Start Prism in a desktop session with a Secret Service keyring to keep new credentials out of auth.json.",
			where,
		);
	}
	return check(
		"Keyring",
		"ok",
		"New credentials are saved in the keyring (Secret Service).",
		"Hypothesis: a D-Bus session bus is present; the keyring answers at the next read or login.",
		"Credentials already in auth.json stay there; no action required.",
		where,
	);
}

function writableDirectory(path: string, label: string): DoctorCheck {
	try {
		accessSync(path, constants.W_OK);
		return check(
			label,
			"ok",
			"Directory exists and is writable.",
			"Confirmed: filesystem access succeeded.",
			"No action required.",
			path,
		);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return check(
			label,
			"problem",
			"Directory is missing or not writable.",
			"Confirmed: filesystem access failed.",
			"Create the directory or grant write access.",
			`${path}: ${detail}`,
		);
	}
}

/**
 * fork: a check that throws is reported, never thrown, so the report still comes out when
 * the configuration it reads is broken.
 */
function guarded(label: string, run: () => DoctorCheck): DoctorCheck {
	try {
		return run();
	} catch (error) {
		return check(
			label,
			"problem",
			"The check itself failed.",
			"Confirmed: reading this item threw an error.",
			"Inspect the technical detail.",
			error instanceof Error ? `${error.name}: ${error.message}` : String(error),
		);
	}
}

const CRASH_AGE = 7 * 24 * 60 * 60 * 1000;

/** fork: the crashes the interactive mode recorded (crashes.json), the last one in detail. */
function crashCheck(agentDir: string, now = Date.now()): DoctorCheck {
	const path = join(agentDir, "crashes.json");
	const recent = readCrashLog(path).filter((record) => now - Date.parse(record.timestamp) <= CRASH_AGE);
	const last = recent.at(-1);
	if (!last) {
		return check(
			"Crashes",
			"ok",
			"No crash recorded in the last 7 days.",
			"Confirmed: the crash log holds no recent record.",
			"No action required.",
			path,
		);
	}
	const frames = (last.stack ?? "")
		.split("\n")
		.slice(1, 4)
		.map((line) => line.trim())
		.filter(Boolean);
	return check(
		"Crashes",
		"problem",
		fill("{0} crash(es) recorded in the last 7 days; the last one: {1}.", String(recent.length), last.timestamp),
		"Confirmed: Prism recorded these crashes in its crash log.",
		"If Prism no longer starts, start it with --safe; attach the exported report when you report the crash.",
		[`${last.timestamp} ${last.version} ${last.kind}: ${last.message}`, ...frames].join(" | "),
	);
}

export function isLocalUrl(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
		return (
			host === "localhost" ||
			host.endsWith(".localhost") ||
			host.endsWith(".local") ||
			host === "::1" ||
			/^127\./.test(host) ||
			/^10\./.test(host) ||
			/^192\.168\./.test(host) ||
			/^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
			// Shared address space, used by Tailscale for machines on the user's own network.
			/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
		);
	} catch {
		return undefined;
	}
}

function serverUrl(modelsPath: string, provider: string): string | undefined {
	try {
		const parsed = JSON.parse(stripJsonComments(stripBom(readFileSync(modelsPath, "utf8")))) as {
			providers?: Record<string, { baseUrl?: unknown }>;
		};
		const value = parsed.providers?.[provider]?.baseUrl;
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

async function modelsCheck(): Promise<DoctorCheck> {
	// Absent is not « valid »: say the optional file is not there.
	if (!existsSync(getModelsPath())) return checkJsonFile(getModelsPath(), "models.json");
	let modelsError: string | undefined;
	try {
		modelsError = (await ModelConfig.load(getModelsPath())).getError();
	} catch (error) {
		modelsError = `Failed to load: ${error instanceof Error ? error.name : String(error)}`;
	}
	if (modelsError) {
		const category = modelsError.startsWith("Failed to load")
			? "load error"
			: modelsError.startsWith("Failed to parse")
				? "parse error"
				: "provider schema error";
		return check(
			"models.json",
			"problem",
			"models.json could not be loaded or validated.",
			"Confirmed: the existing provider validator reported an error.",
			"Fix the provider configuration required by pi, then run /doctor again.",
			`${t(category)}: ${getModelsPath()}`,
		);
	}
	return check(
		"models.json",
		"ok",
		"models.json parses and configured providers pass pi's validation.",
		"Confirmed: the existing provider validator accepted the file.",
		"No action required.",
		getModelsPath(),
	);
}

export async function buildDoctorReport(ctx: ExtensionContext): Promise<DoctorReport> {
	const agentDir = getAgentDir();
	const projectSettings = join(ctx.cwd, CONFIG_DIR_NAME, "settings.json");
	const projectPermissions = join(ctx.cwd, CONFIG_DIR_NAME, "permissions.json");
	const checks = [
		checkJsonFile(getSettingsPath(), "Global settings", false),
		checkJsonFile(projectSettings, "Project settings", false),
	];
	checks.push(await modelsCheck());
	const extensionErrors = getExtensionLoadDiagnostics();
	checks.push(
		...(extensionErrors.length
			? extensionErrors.map(({ path, error }) =>
					check(
						"Extensions",
						"problem",
						"An extension failed to load.",
						"Confirmed: pi recorded a load error.",
						"Start with --safe to isolate extensions, then inspect the technical detail.",
						`${path}: ${error}`,
					),
				)
			: [
					check(
						"Extensions",
						"ok",
						"No extension load errors were recorded at startup.",
						"Confirmed: pi recorded no load errors.",
						"No action required.",
					),
				]),
	);
	const capabilityFile = capabilitiesPath(agentDir);
	checks.push(checkJsonFile(capabilityFile, "Stored capabilities", false));
	const model = ctx.model;
	if (!model) {
		checks.push(
			check(
				"Current model",
				"not tested",
				"No model is selected.",
				"Confirmed: the session has no current model.",
				"Select a model with /model.",
				"Credential availability and model capabilities require a selected model.",
			),
		);
	} else {
		let credentials = "absent";
		try {
			credentials = ctx.modelRegistry.hasConfiguredAuth(model) ? "present" : "absent";
		} catch {
			credentials = "absent";
		}
		const provider = model.provider;
		const states = readCapabilities(capabilityFile, provider, model.id);
		const values = states
			? fill(
					"vision {0}, tool calls {1}, thinking {2}",
					t(states.vision),
					t(states.toolCalls === undefined ? states.tools : states.toolCalls ? "yes" : "no"),
					t(states.reasoning),
				)
			: "none recorded";
		checks.push(
			check(
				"Current model",
				"ok",
				`A model is selected; credentials ${credentials}; stored capabilities: ${values}.`,
				"Confirmed: model selection, credential presence, and stored capability values were read locally.",
				"For unknown capabilities, consult the provider documentation or run capability detection separately.",
				`credentials ${credentials}; ${values}`,
			),
		);
		const url = serverUrl(getModelsPath(), provider) ?? (model as typeof model & { baseUrl?: string }).baseUrl;
		const locality = isLocalUrl(url);
		checks.push(
			check(
				"Model server",
				"not tested",
				locality === undefined
					? "Server location could not be determined from a configured base URL. Reachability was not tested because /doctor makes no network call."
					: locality
						? "Configured server URL appears local. Reachability was not tested because /doctor makes no network call."
						: "Configured server URL appears to be cloud-hosted. Reachability was not tested because /doctor makes no network call.",
				"Hypothesis: location is inferred from the configured base URL only.",
				"Check the provider configuration if this classification is unexpected.",
				`${url ?? t("No configured base URL")}. ${t("Reachability was not tested because /doctor makes no network call.")}`,
			),
		);
	}
	const lastFailure = getLastModelFailure();
	if (lastFailure) {
		checks.push(
			check(
				"Last model request",
				"problem",
				"The last model request returned an error.",
				"Confirmed: the request ended with an error. Hypothesis: a provider or connection problem caused it.",
				"Check the provider status and model configuration; retry only when ready.",
				`${lastFailure.message} (${lastFailure.at})`,
			),
		);
	}
	checks.push(crashCheck(agentDir));
	checks.push(checkJsonFile(join(agentDir, "permissions.json"), "Global permissions", false));
	checks.push(checkJsonFile(projectPermissions, "Project permissions", false));
	checks.push(writableDirectory(agentDir, "Agent directory"));
	checks.push(keyringCheck(agentDir));
	// fork: with --no-session nothing is saved, so the folder that
	// would hold sessions is not tested.
	checks.push(
		ctx.sessionManager.getSessionFile()
			? writableDirectory(ctx.sessionManager.getSessionDir(), "Session directory")
			: check(
					"Session directory",
					"not tested",
					"Sessions are not saved (--no-session).",
					"Confirmed: this session is kept in memory only.",
					"No action required.",
				),
	);
	return { createdAt: new Date().toISOString(), checks };
}

/**
 * fork: the report of `prism doctor`, before anything else loads: no settings manager,
 * extension, model or interface, so it comes out when Prism no longer starts. It reads files only, each check
 * guarded.
 */
export async function buildStartupDoctorReport(paths: {
	cwd: string;
	agentDir: string;
	sessionDir: string;
}): Promise<DoctorReport> {
	const { cwd, agentDir, sessionDir } = paths;
	const checks = [
		guarded("Global settings", () => checkJsonFile(getSettingsPath(), "Global settings", false)),
		guarded("Project settings", () =>
			checkJsonFile(join(cwd, CONFIG_DIR_NAME, "settings.json"), "Project settings", false),
		),
		await modelsCheck(),
		check(
			"Extensions",
			"not tested",
			"Extensions are not loaded by this report.",
			"Confirmed: this report runs before extensions load.",
			"When an extension fails to load, Prism names it at startup; start with --safe to run without extensions.",
		),
		guarded("Stored capabilities", () => checkJsonFile(capabilitiesPath(agentDir), "Stored capabilities", false)),
		guarded("Crashes", () => crashCheck(agentDir)),
		guarded("Global permissions", () =>
			checkJsonFile(join(agentDir, "permissions.json"), "Global permissions", false),
		),
		guarded("Project permissions", () =>
			checkJsonFile(join(cwd, CONFIG_DIR_NAME, "permissions.json"), "Project permissions", false),
		),
		guarded("Agent directory", () => writableDirectory(agentDir, "Agent directory")),
		guarded("Keyring", () => keyringCheck(agentDir)),
		guarded("Session directory", () => writableDirectory(sessionDir, "Session directory")),
	];
	return { createdAt: new Date().toISOString(), checks };
}

/** How the report shows emphasis: the interface's theme, the terminal's colors, or nothing (a pipe, a file). */
export interface DoctorStyle {
	bold(text: string): string;
	dim(text: string): string;
	status(status: DoctorCheck["status"], text: string): string;
}

const PLAIN: DoctorStyle = { bold: (text) => text, dim: (text) => text, status: (_status, text) => text };
const MARKS: Record<DoctorCheck["status"], string> = { problem: "✗", "not tested": "?", ok: "✓" };
const RANK: Record<DoctorCheck["status"], number> = { problem: 0, "not tested": 1, ok: 2 };

/**
 * fork: the maintainer found the report "very dense and raw". A summary line first, then one
 * block per component, problems first: a status mark and the name in bold, then the indented lines, a blank line
 * between blocks.
 */
export function formatDoctorReport(report: DoctorReport, details: boolean, style: DoctorStyle = PLAIN): string {
	const count = (status: DoctorCheck["status"]) =>
		String(report.checks.filter((entry) => entry.status === status).length);
	const summary =
		count("problem") === "0" && count("not tested") === "0"
			? t("everything checked is fine")
			: fill("{0} problem(s), {1} not tested, {2} fine", count("problem"), count("not tested"), count("ok"));
	// fork: diagnostics quote provider errors and extension messages; the
	// displayed report drops their terminal controls, the JSON export keeps them.
	const field = (label: string, value: string) => `   ${style.dim(t(`${label}:`))} ${sanitizeTerminalText(value)}`;
	const blocks = [...report.checks]
		.sort((a, b) => RANK[a.status] - RANK[b.status])
		.map((entry) =>
			[
				`${style.status(entry.status, MARKS[entry.status])} ${style.bold(sanitizeTerminalLabel(entry.component))}  ${style.status(entry.status, t(entry.status))}`,
				field("Observed", entry.observed),
				// A passing check has nothing to explain or do; the export keeps both fields.
				...(entry.status === "ok" ? [] : [field("Cause", entry.cause), field("Action", entry.action)]),
				...(details ? [field("Technical detail", `${entry.detail} (${report.createdAt})`)] : []),
			].join("\n"),
		);
	return [`${style.bold(t("Local diagnostic report"))} · ${summary}`, ...blocks].join("\n\n");
}

export function renderDoctorLines(content: string, width: number): string[] {
	return content
		.split("\n")
		.flatMap((line) => {
			// fork: an indented line wraps under its own indent.
			const indent = /^ */.exec(line)![0];
			const room = Math.max(1, width - indent.length);
			if (indent.length === 0 || room < 10) return wrapTextWithAnsi(line, Math.max(1, width));
			return wrapTextWithAnsi(line.slice(indent.length), room).map((row) => indent + row);
		})
		.map((line) => truncateToWidth(line, width));
}

export function exportDoctorReport(path: string, report: DoctorReport): void {
	writeFileSync(path, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
}

function themeStyle(theme: Theme): DoctorStyle {
	return {
		bold: (text) => theme.bold(text),
		dim: (text) => theme.fg("dim", text),
		status: (status, text) =>
			theme.fg(status === "problem" ? "error" : status === "ok" ? "success" : "warning", text),
	};
}

class DoctorView implements Component {
	private top = 0;
	private lineCount = 0;
	private readonly content: string;
	private readonly close: () => void;
	private readonly redraw: () => void;
	private readonly rows: () => number;
	private readonly dim: (text: string) => string;
	constructor(
		content: string,
		close: () => void,
		redraw: () => void,
		rows: () => number,
		dim: (text: string) => string,
	) {
		this.content = content;
		this.close = close;
		this.redraw = redraw;
		this.rows = rows;
		this.dim = dim;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const lines = renderDoctorLines(this.content, width);
		this.lineCount = lines.length;
		// fork: the terminal's height, not 18 rows.
		const height = Math.max(6, this.rows() - 2);
		// fork: the keys and the position under the report, which ended on its last check.
		const keys = t("↑↓ scroll · PgUp/PgDn page · Home/End top/bottom · Esc close");
		const hint = (position: string) => wrapTextWithAnsi(`${position}${keys}`, width);
		const body = Math.max(3, height - hint(`${lines.length}-${lines.length} / ${lines.length} · `).length);
		this.top = Math.max(0, Math.min(this.top, lines.length - body));
		const end = Math.min(lines.length, this.top + body);
		const position = lines.length > body ? `${this.top + 1}-${end} / ${lines.length} · ` : "";
		return [
			...lines.slice(this.top, end).map((line) => truncateToWidth(line, width)),
			...hint(position).map((line) => this.dim(line)),
		];
	}
	handleInput(data: string): void {
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.cancel")) {
			this.close();
			return;
		}
		if (keys.matches(data, "tui.select.up")) this.top--;
		else if (keys.matches(data, "tui.select.down")) this.top++;
		else if (keys.matches(data, "tui.select.pageUp")) this.top -= 12;
		else if (keys.matches(data, "tui.select.pageDown")) this.top += 12;
		else if (keys.matches(data, "tui.editor.cursorLineStart")) this.top = 0;
		else if (keys.matches(data, "tui.editor.cursorLineEnd")) this.top = this.lineCount;
		else return;
		this.redraw();
	}
}

export default function doctorExtension(pi: ExtensionAPI) {
	pi.on("session_start", (event, ctx) => {
		// The loader's errors are only read at startup; repeating them on /new or /resume adds nothing.
		if (event.reason !== "startup") return;
		const failure = getExtensionLoadDiagnostics()[0];
		if (failure)
			ctx.ui.notify(
				fill(
					"Extension {0} failed to load. Run /doctor for details; start with --safe to isolate it.",
					basename(failure.path),
				),
				"warning",
			);
	});
	pi.registerCommand("doctor", {
		description: t("Check local configuration and runtime paths; /doctor details includes technical details"),
		handler: async (args, ctx) => {
			const details = args?.trim() === "details";
			const exportMatch = /^export\s+(.+)$/.exec(args?.trim() ?? "");
			const report = await buildDoctorReport(ctx);
			if (exportMatch) {
				try {
					const path = resolveToCwd(exportMatch[1]!, ctx.cwd);
					exportDoctorReport(path, report);
					ctx.ui.notify(
						t(
							"Diagnostic report exported. Recognized sensitive information is masked; read the report before sharing it.",
						),
						"info",
					);
				} catch (error) {
					ctx.ui.notify(
						fill(
							"Could not export diagnostic report: {0}",
							error instanceof Error ? error.message : String(error),
						),
						"error",
					);
				}
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(formatDoctorReport(report, details));
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new DoctorView(
						formatDoctorReport(report, details, themeStyle(theme)),
						() => done(undefined),
						() => tui.requestRender(),
						() => tui.terminal.rows,
						(text) => theme.fg("dim", text),
					),
				{
					overlay: true,
					overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%" },
				},
			);
		},
	});
}
