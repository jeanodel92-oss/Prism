/**
 * fork: the module measure runs probes in a profile of its own.
 * - a global extension written relative to the agent dir ("./custom.ts") was copied unchanged and named a file
 *   missing from that profile, so the measure ran without it.
 * - with `-builtin:x` global and `+builtin:x` in the project, x is on in the session; the probe's base (the
 *   global list) and its "flip" (`-builtin:x` again) were both off, and the row said "no change".
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { measureModuleCosts } from "../src/fork/module-cost.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("fork: the module measure compares the module on and off with the global extensions", () => {
	const restore: Array<() => void> = [];
	afterEach(async () => {
		for (const undo of restore.splice(0).reverse()) undo();
		vi.unstubAllEnvs();
	});

	it("loads a global extension given relative to the agent dir, and measures a module the project turned on", async () => {
		const temp = await mkdtemp(join(tmpdir(), "prism-module-cost-settings-"));
		restore.push(() => void rm(temp, { recursive: true, force: true }));
		const agentDir = join(temp, "agent");
		const marker = join(temp, "custom-loaded");
		await mkdir(agentDir);
		await writeFile(
			join(agentDir, "custom.ts"),
			`import { writeFileSync } from "node:fs";\nexport default function () {\n\twriteFileSync(${JSON.stringify(marker)}, "loaded");\n}\n`,
		);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		const originalScript = process.argv[1];
		const originalExecArgv = [...process.execArgv];
		restore.push(() => {
			process.argv[1] = originalScript!;
			process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv);
		});
		process.argv[1] = join(root, "packages/coding-agent/src/experimental/cli.ts");
		process.execArgv.splice(
			0,
			process.execArgv.length,
			"--import",
			pathToFileURL(join(root, "packages/coding-agent/src/experimental/source-resolver.ts")).href,
		);

		const report = await measureModuleCosts({
			// On in the session through the project's `+builtin:reply-language`, off in the global settings.
			modules: [{ name: "reply-language", enabled: true }],
			globalExtensions: ["./custom.ts", "-builtin:reply-language"],
			selected: "reply-language",
			signal: new AbortController().signal,
			onProgress: () => {},
		});

		expect(existsSync(marker)).toBe(true);
		expect(report.rows[0]?.prompt.addedSections).toEqual(["language"]);
	}, 120_000);
});
