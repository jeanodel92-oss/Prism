import {
	type Component,
	getKeybindings,
	type SettingItem,
	SettingsList,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getSettingsListTheme } from "../modes/interactive/theme/theme.ts";
import { fill, t } from "./i18n/index.ts";
import { type ModuleCostReport, measureModuleCosts } from "./module-cost.ts";
import type { BuiltinExtensionSetting } from "./settings-domains.ts";
import { paged, type SettingsPage, type SettingsPageFactory } from "./settings-pages.ts";

export class ModuleCostView implements Component {
	private readonly modules: BuiltinExtensionSetting[];
	private readonly globalExtensions: string[];
	private readonly close: () => void;
	private readonly redraw: () => void;
	private readonly controller = new AbortController();
	private picker: SettingsList;
	private phase: "picker" | "measuring" | "result" = "picker";
	private progress = "";
	private report: ModuleCostReport | undefined;
	private error: string | undefined;
	private scroll = 0;
	private lineCount = 0;

	constructor(modules: BuiltinExtensionSetting[], globalExtensions: string[], close: () => void, redraw: () => void) {
		this.modules = modules;
		this.globalExtensions = globalExtensions;
		this.close = close;
		this.redraw = redraw;
		const items: SettingItem[] = [
			{
				id: "all",
				label: t("All modules"),
				description: t("Measure every built-in module"),
				currentValue: "select",
				values: ["select"],
			},
			...modules.map((module) => ({
				id: module.name,
				label: module.name,
				description: t(module.enabled ? "Currently on" : "Currently off"),
				currentValue: "select",
				values: ["select"],
			})),
		];
		this.picker = new SettingsList(items, 10, getSettingsListTheme(), (id) => void this.measure(id), close);
	}

	invalidate(): void {}

	private async measure(selected: string): Promise<void> {
		this.phase = "measuring";
		this.redraw();
		try {
			this.report = await measureModuleCosts({
				modules: this.modules,
				globalExtensions: this.globalExtensions,
				selected,
				signal: this.controller.signal,
				onProgress: (index, total, module) => {
					this.progress = fill("Measuring {0}/{1}: {2}…", String(index), String(total), module);
					this.redraw();
				},
			});
			this.phase = "result";
		} catch (error) {
			if (this.controller.signal.aborted) return;
			this.error = fill("Measurement failed: {0}", error instanceof Error ? error.message : String(error));
			this.phase = "result";
		}
		this.redraw();
	}

	private lines(): string[] {
		if (this.phase === "picker") return [t("Measure module cost"), ...this.picker.render(this.width)];
		if (this.phase === "measuring")
			return [t("Measure module cost"), this.progress, t("Esc cancels and stops the probe process.")];
		if (!this.report) return [t("Measure module cost"), this.error ?? t("No result."), t("Esc close")];
		return [t("Module cost results"), ...moduleCostReportLines(this.report), "", t("↑↓ scroll · Esc close")];
	}

	private width = 80;

	render(width: number): string[] {
		this.width = width;
		const lines = this.lines().flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
		this.lineCount = lines.length;
		const height = 18;
		this.scroll = Math.max(0, Math.min(this.scroll, lines.length - height));
		return lines.slice(this.scroll, this.scroll + height).map((line) => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (this.phase === "picker") {
			this.picker.handleInput(data);
			return;
		}
		if (this.phase === "measuring") {
			if (keys.matches(data, "tui.select.cancel")) {
				this.controller.abort();
				this.close();
			}
			return;
		}
		if (keys.matches(data, "tui.select.cancel")) this.close();
		else if (keys.matches(data, "tui.select.up")) this.scroll--;
		else if (keys.matches(data, "tui.select.down")) this.scroll++;
		else if (keys.matches(data, "tui.select.pageUp")) this.scroll -= 12;
		else if (keys.matches(data, "tui.select.pageDown")) this.scroll += 12;
		else if (keys.matches(data, "tui.editor.cursorLineStart")) this.scroll = 0;
		else if (keys.matches(data, "tui.editor.cursorLineEnd")) this.scroll = this.lineCount;
		else return;
		this.redraw();
	}
}

/** the report's lines, which the terminal scrolls and the Prism window shows as text. */
function moduleCostReportLines(report: ModuleCostReport): string[] {
	const { baselinePromptTokens, rows } = report;
	return [
		`${t("Baseline prompt")}: ${baselinePromptTokens} ${t("tokens, estimate")}`,
		`${t("Baseline startup")}: ${report.baselineStartupMs === undefined ? t("unknown") : `${formatNumber(report.baselineStartupMs)} ${t("ms, measured")}`}`,
		`${t("Baseline memory")}: ${report.baselineMemoryMiB === undefined ? t("unknown") : `${formatNumber(report.baselineMemoryMiB)} ${t("MiB, measured")}`}`,
		`${t("Baseline processes")}: ${report.baselineProcesses === undefined ? t("unknown") : formatNumber(report.baselineProcesses)}`,
		...rows.flatMap((row) => [
			row.name,
			row.prompt.changed
				? `  ${t("Prompt per turn")}: +${row.prompt.addedTokens}/-${row.prompt.removedTokens} ${t("tokens, estimate")}`
				: `  ${t("Prompt per turn")}: ${t("no change")}`,
			`  ${t("Cache on toggle")}: ${row.prompt.changed ? `+${row.prompt.addedTokens}/-${row.prompt.removedTokens} ${t("tokens once, estimate")}` : t("no change")}`,
			`  ${t("Startup")}: ${row.startup} ${t("measured")}`,
			`  ${t("Memory")}: ${row.memory} ${t("measured")}`,
			`  ${t("Processes")}: ${row.processes}`,
		]),
		"",
		t("Method"),
		t(
			"Each module is compared on and off in the same isolated print-mode child; 3 sequential runs per state are interleaved and medians are reported.",
		),
		t(
			"The child uses PI_OFFLINE=1 and a local probe provider; no external request is made. Only global extensions are copied to temporary settings.json; auth, sessions and other user files are not read.",
		),
		t(
			"Prompt and cache token counts use estimateTextTokens. Startup is process uptime at first request; RSS and child count are read at that point.",
		),
		t(
			"Prompt changes diff the base text, named sections and tool definitions across system messages; unchanged shared items are not attributed. Cache on toggle estimates the changed prompt written once. The child starts from an empty profile: what a module adds only from your files (memories, context files) is not counted.",
		),
		process.platform === "linux"
			? t(
					"A delta below either side's run spread is shown as below noise. Child process count uses /proc and is unknown if /proc is unavailable; cancellation sends SIGTERM to the probe process group.",
				)
			: t(
					"A delta below either side's run spread is shown as below noise. Child process count is unknown off Linux; cancelled children receive SIGTERM.",
				),
	];
}

function formatNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * the same tool for the Prism window: one row per choice, each opening its measurement as text.
 * Going back while it runs stops the probe, as Esc does in the terminal.
 */
export function moduleCostPage(
	modules: BuiltinExtensionSetting[],
	globalExtensions: string[],
	redraw: () => void,
): SettingsPageFactory {
	const measurement =
		(selected: string): SettingsPageFactory =>
		(_current, close) => {
			const controller = new AbortController();
			const page: Extract<SettingsPage, { kind: "text" }> = {
				kind: "text",
				title: "Measure module cost",
				lines: [],
				done: () => {
					controller.abort();
					close();
				},
			};
			measureModuleCosts({
				modules,
				globalExtensions,
				selected,
				signal: controller.signal,
				onProgress: (index, total, module) => {
					page.lines = [fill("Measuring {0}/{1}: {2}…", String(index), String(total), module)];
					redraw();
				},
			}).then(
				(report) => {
					page.title = "Module cost results";
					page.lines = moduleCostReportLines(report);
					redraw();
				},
				(error: unknown) => {
					if (controller.signal.aborted) return;
					page.lines = [fill("Measurement failed: {0}", error instanceof Error ? error.message : String(error))];
					redraw();
				},
			);
			return page;
		};
	const row = (id: string, label: string, description: string): SettingItem => ({
		id,
		label,
		description,
		currentValue: t("Measure"),
		...paged(measurement(id)),
	});
	return (_value, done) => ({
		kind: "rows",
		title: "Measure module cost",
		description: "Measure prompt, startup, memory and child processes on demand.",
		items: [
			row("all", t("All modules"), t("Measure every built-in module")),
			...modules.map((module) =>
				row(module.name, module.name, t(module.enabled ? "Currently on" : "Currently off")),
			),
		],
		onChange: () => {},
		onClose: () => done(),
	});
}
