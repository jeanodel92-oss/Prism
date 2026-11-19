/**
 * fork: the page of /settings › Permissions & sandbox that moves the credentials still in clear to
 * the keyring (migration.ts). It lists them first; Enter asks for the confirmation, a second Enter moves them,
 * Esc goes back at every step. The result says what moved and what stayed in clear, with the reason; opening the
 * page again retries the rest.
 */
import {
	type Component,
	getKeybindings,
	type SettingItem,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { fill, t } from "../i18n/index.ts";
import { paged, type SettingsPage, type SettingsPageFactory } from "../settings-pages.ts";
import { keyringEnabled } from "./keyring.ts";
import type { MigrationResult } from "./migration.ts";

export interface MigrationPageOptions {
	/** The credentials in clear, read again each time the page is drawn before the move. */
	entries(): Array<{ provider: string; type: string }>;
	migrate(): Promise<MigrationResult>;
	requestRender(): void;
	/** Closes the page; `changed` when something moved. */
	done(changed: boolean): void;
}

const TYPES: Record<string, string> = { api_key: "API key", oauth: "OAuth tokens" };

export class MigrationPage implements Component {
	private readonly options: MigrationPageOptions;
	private step: "list" | "confirm" | "moving" | "done" = "list";
	private result: MigrationResult | undefined;
	private error: string | undefined;

	constructor(options: MigrationPageOptions) {
		this.options = options;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const out: string[] = [];
		const add = (text: string) => {
			const cut = truncateToWidth(text, Math.max(0, width), "…");
			out.push(`${cut}${" ".repeat(Math.max(0, width - visibleWidth(cut)))}`);
		};
		const wrap = (text: string) => {
			for (const line of wrapTextWithAnsi(text, width)) add(line);
		};
		add(theme.bold(theme.fg("accent", t("Move credentials to the keyring"))));
		wrap(
			theme.fg(
				"muted",
				t(
					"Credentials saved before the keyring was used are still in clear in auth.json. Each one is stored in the keyring and read back before auth.json keeps only a marker; one that fails stays in clear. References to a command or a variable stay.",
				),
			),
		);
		add("");
		if (this.step === "done") {
			this.renderResult(add, wrap);
			return out;
		}
		const entries = this.options.entries();
		if (!keyringEnabled()) {
			wrap(theme.fg("warning", t("No keyring in this session: nothing can be moved.")));
			add(theme.fg("muted", t("Esc back")));
			return out;
		}
		if (!entries.length) {
			wrap(theme.fg("text", t("No credential in clear in auth.json.")));
			add(theme.fg("muted", t("Esc back")));
			return out;
		}
		for (const { provider, type } of entries)
			add(`  ${theme.fg("text", provider)} ${theme.fg("dim", `· ${t(TYPES[type] ?? type)}`)}`);
		add("");
		const count = String(entries.length);
		if (this.step === "moving") wrap(theme.fg("muted", t("Moving to the keyring…")));
		else if (this.step === "confirm")
			wrap(theme.fg("warning", fill("Move {0} credential(s) to the keyring? Enter confirms, Esc cancels.", count)));
		else wrap(theme.fg("muted", fill("Enter moves {0} credential(s) to the keyring · Esc back", count)));
		return out;
	}

	private renderResult(add: (text: string) => void, wrap: (text: string) => void): void {
		const result = this.result;
		if (this.error) wrap(theme.fg("error", fill("Nothing was moved: {0}", this.error)));
		if (result?.moved.length) wrap(theme.fg("success", fill("Moved to the keyring: {0}", result.moved.join(", "))));
		for (const [provider, reason] of result?.kept ?? [])
			wrap(theme.fg("error", fill("Kept in clear: {0} ({1})", provider, t(reason))));
		if (result && !result.moved.length && !result.kept.size)
			wrap(theme.fg("text", t("No credential in clear in auth.json.")));
		if (this.error || result?.kept.size)
			wrap(theme.fg("muted", t("Unlock the keyring if needed, then open this page again to retry.")));
		add("");
		add(theme.fg("muted", t("Enter or Esc closes")));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const confirm = kb.matches(data, "tui.select.confirm");
		const cancel = kb.matches(data, "tui.select.cancel");
		if (this.step === "moving") return;
		if (this.step === "done") {
			if (confirm || cancel) this.options.done(!!this.result?.moved.length);
			return;
		}
		if (this.step === "confirm") {
			if (confirm) this.move();
			else if (cancel) this.step = "list";
			return;
		}
		if (cancel) this.options.done(false);
		else if (confirm && keyringEnabled() && this.options.entries().length) this.step = "confirm";
	}

	private move(): void {
		this.step = "moving";
		this.options.requestRender();
		// The keyring is called without blocking: the interface keeps drawing meanwhile.
		this.options
			.migrate()
			.then(
				(result) => {
					this.result = result;
				},
				(error: unknown) => {
					this.error = error instanceof Error ? error.message : String(error);
				},
			)
			.finally(() => {
				this.step = "done";
				this.options.requestRender();
			});
	}
}

/**
 * the same page for the Prism window, as rows: the credentials in clear, then "Move to the keyring",
 * which asks first. The move runs in the background; the page then says what moved and what stayed in clear.
 */
export function migrationSettingsPage(options: Omit<MigrationPageOptions, "done">): SettingsPageFactory {
	return (_value, done) => {
		let step: "list" | "moving" | "done" = "list";
		let result: MigrationResult | undefined;
		let error: string | undefined;
		const intro = t(
			"Credentials saved before the keyring was used are still in clear in auth.json. Each one is stored in the keyring and read back before auth.json keeps only a marker; one that fails stays in clear. References to a command or a variable stay.",
		);
		const page: Extract<SettingsPage, { kind: "rows" }> = {
			kind: "rows",
			title: t("Move credentials to the keyring"),
			description: intro,
			items: [],
			onChange: () => {},
			onClose: () => done(result?.moved.length ? "changed" : undefined),
		};
		const move = () => {
			step = "moving";
			refresh();
			// The keyring is called without blocking: the window keeps drawing meanwhile.
			options
				.migrate()
				.then(
					(moved) => {
						result = moved;
					},
					(failure: unknown) => {
						error = failure instanceof Error ? failure.message : String(failure);
					},
				)
				.finally(() => {
					step = "done";
					refresh();
					options.requestRender();
				});
		};
		// The window draws `items` and `description` again at each change: they are replaced in place.
		const refresh = () => {
			const status: string[] = [];
			const rows: SettingItem[] = [];
			if (step === "done") {
				if (error) status.push(fill("Nothing was moved: {0}", error));
				if (result?.moved.length) status.push(fill("Moved to the keyring: {0}", result.moved.join(", ")));
				for (const [provider, reason] of result?.kept ?? [])
					status.push(fill("Kept in clear: {0} ({1})", provider, t(reason)));
				if (result && !result.moved.length && !result.kept.size)
					status.push(t("No credential in clear in auth.json."));
				if (error || result?.kept.size)
					status.push(t("Unlock the keyring if needed, then open this page again to retry."));
			} else {
				const entries = options.entries();
				if (!keyringEnabled()) status.push(t("No keyring in this session: nothing can be moved."));
				else if (!entries.length) status.push(t("No credential in clear in auth.json."));
				else if (step === "moving") status.push(t("Moving to the keyring…"));
				for (const { provider, type } of entries)
					rows.push({
						id: `entry:${provider}`,
						label: provider,
						description: "",
						currentValue: t(TYPES[type] ?? type),
					});
				if (keyringEnabled() && entries.length && step === "list") {
					const count = String(entries.length);
					rows.push({
						id: "move",
						label: t("Move credentials to the keyring"),
						description: "",
						currentValue: fill("{0} in clear", count),
						...paged((_current, close) => ({
							kind: "select",
							title: t("Move credentials to the keyring"),
							description: fill("Move {0} credential(s) to the keyring?", count),
							options: [
								{ value: "move", label: t("Move") },
								{ value: "keep", label: t("Cancel") },
							],
							current: "keep",
							onSelect: (value) => {
								close();
								if (value === "move") move();
							},
							onCancel: () => close(),
						})),
					});
				}
			}
			page.description = [intro, ...status].join("\n");
			page.items.splice(0, page.items.length, ...rows);
		};
		refresh();
		return page;
	};
}
