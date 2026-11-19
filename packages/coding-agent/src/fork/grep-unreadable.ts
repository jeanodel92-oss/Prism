/**
 * fork: rg exits with code 2 when some paths could not be read (permission denied,
 * vanished file) even though it searched the others. grep used to reject the whole call, so one
 * unreadable folder in a project hid every match. Those per-path errors now become a notice.
 * fd skips unreadable folders silently, so find said "No files found" for a folder it could not
 * open; with `--show-errors` it reports them, and find gives the same notice.
 */

/** rg's per-path errors when stderr holds nothing else, otherwise undefined (a real failure). */
export function unreadablePathErrors(stderr: string): string[] | undefined {
	const lines = stderr
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0 || !lines.every((line) => /^rg: .+: .+ \(os error \d+\)$/.test(line))) return undefined;
	return lines.map((line) => line.slice("rg: ".length));
}

/** fd's per-path errors (`--show-errors`); other stderr lines are left to the exit code. */
export function fdUnreadablePathErrors(stderr: string): string[] {
	return stderr.split("\n").flatMap((line) => {
		const match = /^\[fd error\]: (.+: .+ \(os error \d+\))$/.exec(line.trim());
		return match ? [match[1]!] : [];
	});
}

export function unreadablePathsNotice(errors: string[]): string {
	const shown = errors.slice(0, 3).join("; ");
	const more = errors.length > 3 ? ` and ${errors.length - 3} more` : "";
	return `${errors.length} path(s) could not be searched: ${shown}${more}`;
}

/**
 * fork: rg --json gives a path or line that is not UTF-8 as base64 `bytes`
 * instead of `text`. grep read only `text`, so such a match was counted against the limit and then dropped.
 * The bytes are shown decoded, with U+FFFD for what is not UTF-8; `raw` says the name is not the file's real one.
 */
export function ripgrepText(field: unknown): { text: string; raw: boolean } | undefined {
	if (typeof field !== "object" || field === null) return undefined;
	const { text, bytes } = field as { text?: unknown; bytes?: unknown };
	if (typeof text === "string") return { text, raw: false };
	if (typeof bytes === "string") return { text: Buffer.from(bytes, "base64").toString("utf8"), raw: true };
	return undefined;
}

export const NON_UTF8_PATHS_NOTICE =
	"Some file names are not valid UTF-8: they are shown with �, and without context lines";
