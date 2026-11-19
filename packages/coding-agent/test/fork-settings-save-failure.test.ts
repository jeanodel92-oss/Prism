// fork: `install`, `remove` and `config` wait for the settings to be written and
// report a write that failed, instead of a success while settings.json still holds the old configuration.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { handleConfigCommand, handlePackageCommand } from "../src/package-manager-cli.ts";

const { selectConfigMock } = vi.hoisted(() => ({ selectConfigMock: vi.fn() }));
vi.mock("../src/cli/config-selector.ts", () => ({ selectConfig: selectConfigMock }));

describe.runIf(process.getuid?.() !== 0)("fork: settings that cannot be saved (review 2026-11-09, CR-244)", () => {
	let dir: string;
	let agentDir: string;
	let packageDir: string;
	let settingsPath: string;
	let output: string[];
	const savedAgentDir = process.env[ENV_AGENT_DIR];
	const savedCwd = process.cwd();
	const savedExitCode = process.exitCode;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-settings-save-"));
		agentDir = join(dir, "agent");
		packageDir = join(dir, "local-package");
		mkdirSync(agentDir);
		mkdirSync(packageDir);
		mkdirSync(join(dir, "project"));
		settingsPath = join(agentDir, "settings.json");
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(join(dir, "project"));
		process.exitCode = undefined;
		output = [];
		for (const method of ["log", "error", "warn"] as const)
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void output.push(args.join(" ")));
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			process.exitCode = code;
		}) as typeof process.exit);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		chmodSync(settingsPath, 0o644);
		process.chdir(savedCwd);
		process.exitCode = savedExitCode;
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		rmSync(dir, { recursive: true, force: true });
	});

	/** settings.json with `packages`, then read-only: it can be read, not written. */
	const lockSettings = (packages: string[]) => {
		writeFileSync(settingsPath, `${JSON.stringify({ packages })}\n`);
		chmodSync(settingsPath, 0o444);
	};
	const onDisk = () => (JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] }).packages;

	it("remove says the package is still configured and exits 1", async () => {
		lockSettings([packageDir]);
		expect(await handlePackageCommand(["remove", packageDir])).toBe(true);
		expect(onDisk()).toEqual([packageDir]);
		expect(process.exitCode).toBe(1);
		expect(output.join("\n")).not.toMatch(/^Removed /m);
		expect(output.join("\n")).toContain("could not be saved");
	});

	it("install says the package is not configured and exits 1", async () => {
		lockSettings([]);
		expect(await handlePackageCommand(["install", packageDir])).toBe(true);
		expect(onDisk()).toEqual([]);
		expect(process.exitCode).toBe(1);
		expect(output.join("\n")).not.toMatch(/^Installed /m);
		expect(output.join("\n")).toContain("could not be saved");
	});

	it("config reports a change it could not save and exits 1", async () => {
		lockSettings([]);
		selectConfigMock.mockImplementation(async (options: { settingsManager: { setPackages(p: string[]): void } }) => {
			options.settingsManager.setPackages([packageDir]);
		});
		await handleConfigCommand(["config"]);
		expect(onDisk()).toEqual([]);
		expect(process.exitCode).toBe(1);
		expect(output.join("\n")).toContain("could not be saved");
	});
});
