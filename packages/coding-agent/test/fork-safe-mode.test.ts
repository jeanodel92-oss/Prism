import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { getSafeModeDiagnostics, SAFE_MODE_NOTICE } from "../src/fork/safe-mode.ts";

describe("fork: --safe", () => {
	test("combines the minimal-startup flags", () => {
		const result = parseArgs(["--safe"]);
		expect(result.safe).toBe(true);
		expect(result.noExtensions).toBe(true);
		expect(result.noSkills).toBe(true);
		expect(result.noPromptTemplates).toBe(true);
		expect(result.noThemes).toBe(true);
		expect(result.useTheme).toBe("system");
		expect(result.noContextFiles).toBe(true);
		expect(result.verbose).toBe(true);
		expect(result.diagnostics).toEqual([]);
	});

	test("keeps explicitly passed extensions", () => {
		const result = parseArgs(["--safe", "-e", "./ext.ts", "-p", "hi"]);
		expect(result.extensions).toEqual(["./ext.ts"]);
		expect(result.print).toBe(true);
		expect(result.messages).toEqual(["hi"]);
	});

	test("keeps an explicit --use-theme", () => {
		expect(parseArgs(["--use-theme", "dark", "--safe"]).useTheme).toBe("dark");
		expect(parseArgs(["--safe", "--use-theme", "dark"]).useTheme).toBe("dark");
	});

	test("announces itself only when set", () => {
		expect(getSafeModeDiagnostics(parseArgs(["--safe"]))).toEqual([{ type: "warning", message: SAFE_MODE_NOTICE }]);
		expect(getSafeModeDiagnostics(parseArgs([]))).toEqual([]);
	});
});
