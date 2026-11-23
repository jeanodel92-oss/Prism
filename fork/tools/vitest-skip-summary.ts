/**
 * fork: the `dot` reporter says how many tests were skipped,
 * not which, so a green run hid that the desktop-control, browser and container suites did not run (no labwc,
 * Firefox, podman or API key on that machine). This reporter lists the skipped tests per file at the end of a run,
 * so the log shows what a run really covered. It prints nothing when no test was skipped.
 */
import type { Reporter, TestModule } from "vitest/node";

export default class SkipSummary implements Reporter {
	onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
		const rows: Array<{ file: string; skipped: number; total: number }> = [];
		for (const module of testModules) {
			const skipped = [...module.children.allTests("skipped")].length;
			if (skipped === 0) continue;
			rows.push({ file: module.relativeModuleId, skipped, total: [...module.children.allTests()].length });
		}
		if (rows.length === 0) return;
		rows.sort((a, b) => b.skipped - a.skipped || a.file.localeCompare(b.file));
		const count = rows.reduce((sum, row) => sum + row.skipped, 0);
		const lines = rows.map((row) => `  ${row.file}: ${row.skipped} of ${row.total}`);
		process.stdout.write(`\nSkipped tests: ${count} in ${rows.length} file(s)\n${lines.join("\n")}\n`);
	}
}
