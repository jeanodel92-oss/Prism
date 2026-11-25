import { resolve } from "node:path";
import type { ExtensionAPI, ToolResultEvent } from "../core/extensions/types.ts";
import { readGlobalSetting, saveGlobalSetting } from "./global-settings.ts";
import { fill, t } from "./i18n/index.ts";
import { detectInjection, INJECTION_THRESHOLD, INJECTION_WINDOW, visibleInjectionText } from "./injection-detector.ts";
import { hasInteractiveClient } from "./interactive-client.ts";
import { type SettingsSection, setSettingsSection, settingsSections } from "./settings-sections.ts";

/** Collect only the bounded ends, even when a tool splits its output over many blocks. */
function resultWindow(content: ToolResultEvent["content"], end: boolean): string {
	const parts: string[] = [];
	let left = INJECTION_WINDOW;
	for (let i = end ? content.length - 1 : 0; left > 0 && i >= 0 && i < content.length; i += end ? -1 : 1) {
		const part = content[i]!;
		if (part.type !== "text") continue;
		const text = end ? part.text.slice(-left) : part.text.slice(0, left);
		parts.push(text);
		left -= text.length;
	}
	return (end ? parts.reverse() : parts).join("");
}

export default function injectionWarning(pi: ExtensionAPI): void {
	let enabled = true;
	let section: SettingsSection | undefined;
	const accepted = new Set<string>();
	let waiting = Promise.resolve();

	pi.on("session_start", (_event, ctx) => {
		enabled = readGlobalSetting("injectionWarning") !== false;
		accepted.clear();
		section = {
			domain: "permissions",
			items: () => [
				{
					id: "injection-warning",
					label: "Hidden instructions alert",
					description:
						"Stops the agent when something it reads (a page, a file, a command's output) holds instructions that seem meant for it, and asks whether to continue. A risk reduction, not a guarantee; the content is never changed.",
					currentValue: enabled ? "on" : "off",
					values: ["on", "off"],
				},
			],
			onChange: (id, value) => {
				if (id !== "injection-warning") return;
				try {
					saveGlobalSetting(["injectionWarning"], value === "on");
					enabled = value === "on";
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		};
		setSettingsSection("injection-warning", section);
	});
	pi.on("session_shutdown", () => {
		if (section && settingsSections().includes(section)) setSettingsSection("injection-warning", undefined);
	});
	pi.on("tool_result", async (event, ctx) => {
		if (!enabled || ctx.signal?.aborted) return;
		const sources = Object.entries(event.input).flatMap(([key, value]) => {
			if (!["path", "url", "urls", "server", "serverName", "command", "query"].includes(key)) return [];
			const values =
				typeof value === "string"
					? [value]
					: Array.isArray(value)
						? value.filter((v): v is string => typeof v === "string")
						: [];
			return values.map((v) => `${key}: ${key === "path" ? resolve(ctx.cwd, v) : v}`);
		});
		const sourceKey = JSON.stringify([event.toolName, ...sources]);
		if (accepted.has(sourceKey)) return;
		const detected = detectInjection(`${resultWindow(event.content, false)}\n${resultWindow(event.content, true)}`);
		if (detected.score < INJECTION_THRESHOLD) return;
		const title = fill("Possible prompt injection in the result of {0}", visibleInjectionText(event.toolName));
		const message = [
			ctx.mode === "tui" ? ctx.ui.theme.fg("warning", t("WARNING")) : t("WARNING"),
			title,
			fill("Source: {0}", [event.toolName, ...sources].map((s) => visibleInjectionText(s)).join(" · ")),
			...detected.findings.map((finding) => `${t(finding.kind)}: ${finding.excerpt}`),
			t("The content was not changed."),
		].join("\n");
		if (!ctx.hasUI || (ctx.mode === "rpc" && !hasInteractiveClient(ctx))) {
			if (ctx.mode === "rpc") ctx.ui.notify(message, "warning");
			else process.stderr.write(`${message}\n`);
			return;
		}
		// Tools can finish in parallel; one question must not replace another unanswered question.
		const previous = waiting;
		let release = () => {};
		waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			if (!enabled || ctx.signal?.aborted || accepted.has(sourceKey)) return;
			ctx.ui.notify(title, "warning");
			const stop = t("Stop the agent");
			const proceed = t("Continue");
			const remember = t("Continue, and don't ask again for this source in this session");
			const choice = await ctx.ui.select(message, [stop, proceed, remember], {
				signal: ctx.signal,
				toolCallId: event.toolCallId,
				tone: "warning",
			});
			if (choice === remember) accepted.add(sourceKey);
			else if (choice !== proceed) {
				ctx.abort();
				ctx.ui.notify(
					t("Agent stopped because a tool result may contain a prompt injection. The content was not changed."),
					"warning",
				);
			}
		} catch (error) {
			ctx.abort();
			throw error;
		} finally {
			release();
		}
	});
}
