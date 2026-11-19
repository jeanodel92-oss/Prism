/**
 * fork: `prism doctor`, the diagnostic that runs when Prism no longer starts. main.ts calls
 * it before the settings manager, the migrations, the extensions and the interface; it reads files only.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import chalk from "chalk";
import { APP_NAME, ENV_SESSION_DIR, expandTildePath, getAgentDir, getSessionsDir, getSettingsPath } from "../config.ts";
import { resolveToCwd } from "../core/tools/path-utils.ts";
import { stripJsonComments } from "../utils/json.ts";
import { stripBom } from "../utils/text.ts";
import { buildStartupDoctorReport, type DoctorStyle, exportDoctorReport, formatDoctorReport } from "./doctor.ts";
import { fill, resolveLanguage, setLanguage, t } from "./i18n/index.ts";

/** The global settings when they parse, else nothing: a broken file is what the report is for. */
function readSettings(): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(stripJsonComments(stripBom(readFileSync(getSettingsPath(), "utf8"))));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

const COLORS: DoctorStyle = {
	bold: (text) => chalk.bold(text),
	dim: (text) => chalk.dim(text),
	status: (status, text) =>
		status === "problem" ? chalk.red(text) : status === "ok" ? chalk.green(text) : chalk.yellow(text),
};

function printHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} doctor`)} - ${t("check the local setup without starting the interface")}

${chalk.bold(t("Usage:"))}
  ${APP_NAME} doctor                 ${t("Report on settings, models, permissions, crashes and folders")}
  ${APP_NAME} doctor details         ${t("Add the technical detail of each check")}
  ${APP_NAME} doctor export <${t("file")}>   ${t("Save the report as JSON (recognized sensitive information and home folder masked, mode 0600)")}

${t("The exit code is 1 when a problem is found.")}`);
}

/** Run `doctor` when it is the command; false otherwise. */
export async function runDoctorCommand(args: readonly string[]): Promise<boolean> {
	if (args[0] !== "doctor") return false;
	const settings = readSettings();
	setLanguage(resolveLanguage(settings.language));
	const rest = args.slice(1);
	if (rest.includes("--help") || rest.includes("-h")) {
		printHelp();
		return true;
	}
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const configured =
		process.env[ENV_SESSION_DIR] ?? (typeof settings.sessionDir === "string" ? settings.sessionDir : "");
	let sessionDir = configured ? expandTildePath(configured) : getSessionsDir();
	// Not created before the first session: the folder that will hold it is what must be writable.
	if (!existsSync(sessionDir) && !configured) sessionDir = dirname(sessionDir);
	const report = await buildStartupDoctorReport({ cwd, agentDir, sessionDir });
	if (rest[0] === "export") {
		if (!rest[1]) {
			console.error(chalk.red(t("Give the file to write: doctor export <file>")));
			process.exitCode = 2;
			return true;
		}
		try {
			exportDoctorReport(resolveToCwd(rest[1], cwd), report);
			console.log(
				t(
					"Diagnostic report exported. Recognized sensitive information is masked; read the report before sharing it.",
				),
			);
		} catch (error) {
			console.error(
				chalk.red(
					fill("Could not export diagnostic report: {0}", error instanceof Error ? error.message : String(error)),
				),
			);
			process.exitCode = 2;
			return true;
		}
	} else {
		const style = process.stdout.isTTY && !process.env.NO_COLOR ? COLORS : undefined;
		console.log(formatDoctorReport(report, rest[0] === "details", style));
	}
	if (report.checks.some((entry) => entry.status === "problem")) process.exitCode = 1;
	return true;
}
