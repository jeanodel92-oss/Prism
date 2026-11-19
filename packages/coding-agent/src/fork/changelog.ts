// fork: a branded build's /changelog shows Prism's release notes
// (fork/CHANGELOG.md), not upstream pi's CHANGELOG.md. fork/scripts/install-local.sh
// copies fork/CHANGELOG.md into the package under this name.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { getPackageDir } from "../config.ts";
import { DocReader } from "./docs-command.ts";
import { t } from "./i18n/index.ts";

export const PRISM_CHANGELOG_FILE = "PRISM-CHANGELOG.md";

export function getPrismChangelogPath(packageDir: string = getPackageDir()): string {
	const bundled = join(packageDir, PRISM_CHANGELOG_FILE);
	const source = resolve(packageDir, "../../fork/CHANGELOG.md");
	return existsSync(bundled) || !existsSync(source) ? bundled : source;
}

/**
 * fork/CHANGELOG.md is wrapped at 80 columns, and the TUI's Markdown keeps single
 * line breaks: join each wrapped line to the paragraph or list item it continues.
 */
export function unwrapChangelog(markdown: string): string {
	const lines: string[] = [];
	for (const line of markdown.split("\n")) {
		const previous = lines[lines.length - 1];
		const startsBlock = /^\s*$|^\s*(#|[-*+] |\d+\. |\||>|```)/.test(line);
		const continues = previous !== undefined && !/^\s*$|^\s*(#|\||```)/.test(previous);
		if (!startsBlock && continues) lines[lines.length - 1] = `${previous} ${line.trim()}`;
		else lines.push(line);
	}
	return lines.join("\n");
}

/**
 * fork: /changelog opens its notes in the /docs reader, closable and searchable, instead
 * of appending the whole history to the conversation ("masse de texte irréversible dans la conversation").
 */
export function changelogReader(markdown: string, tui: TUI, done: () => void): DocReader {
	return new DocReader(
		t("What's New"),
		markdown,
		() => Math.max(8, Math.floor(tui.terminal.rows * 0.75)),
		done,
		() => tui.requestRender(),
		"close",
	);
}

/** As /docs: an overlay, so Page Up/Down and End do not scroll the conversation in fullscreen mode. */
export const CHANGELOG_READER_OVERLAY: OverlayOptions = { anchor: "bottom-center", width: "100%", maxHeight: "100%" };
