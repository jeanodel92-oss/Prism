import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager, type ResolvedResource } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function entry(resources: ResolvedResource[], name: string): ResolvedResource | undefined {
	return resources.find((r) => r.path.endsWith(`/${name}`));
}

describe("package manager resource boundaries", () => {
	let tempDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "fork-pm-boundaries-"));
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writePackage(pi: Record<string, string[]>): string {
		const pkgDir = join(tempDir, "plugin");
		mkdirSync(join(pkgDir, "prompts"), { recursive: true });
		writeFileSync(join(pkgDir, "plugin.ts"), "export default function() {}");
		writeFileSync(join(pkgDir, "prompts", "internal.md"), "internal prompt");
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "plugin", pi }));
		return pkgDir;
	}

	// an update for one scope leaves the same package in the other scope alone.
	it("updates only the chosen scope's copy of a package configured in both", async () => {
		settingsManager.setPackages(["npm:example"]);
		settingsManager.setProjectPackages(["npm:example"]);
		const sources: unknown[] = [];
		const spy = vi
			.spyOn(
				packageManager as unknown as { updateConfiguredSources(s: unknown[]): Promise<void> },
				"updateConfiguredSources",
			)
			.mockImplementation(async (list) => {
				sources.push(...list);
			});
		await packageManager.update("npm:example", { local: true });
		expect(sources).toEqual([{ source: "npm:example", scope: "project" }]);
		sources.length = 0;
		await packageManager.update("npm:example", { local: false });
		expect(sources).toEqual([{ source: "npm:example", scope: "user" }]);
		sources.length = 0;
		await packageManager.update("npm:example");
		expect(sources).toEqual([
			{ source: "npm:example", scope: "user" },
			{ source: "npm:example", scope: "project" },
		]);
		spy.mockRestore();
	});

	// a user filter on one category must not open categories the manifest does not export.
	it("keeps categories absent from the manifest absent when another category is filtered", async () => {
		const pkgDir = writePackage({ extensions: ["plugin.ts"] });

		settingsManager.setPackages([pkgDir]);
		const plain = await packageManager.resolve();
		expect(plain.prompts).toEqual([]);

		settingsManager.setPackages([{ source: pkgDir, extensions: ["-plugin.ts"] }]);
		const filtered = await packageManager.resolve();
		expect(filtered.prompts).toEqual([]);
		expect(entry(filtered.extensions, "plugin.ts")?.enabled).toBe(false);
	});

	it("treats an empty manifest category as empty under a user filter", async () => {
		const pkgDir = writePackage({ extensions: ["plugin.ts"], prompts: [] });
		settingsManager.setPackages([{ source: pkgDir, prompts: ["!**/other.md"] }]);
		const result = await packageManager.resolve();
		expect(result.prompts).toEqual([]);
	});

	// character classes and braces are globs even without * or ?.
	it("expands manifest globs that use only character classes or braces", async () => {
		const pkgDir = join(tempDir, "globbed");
		mkdirSync(join(pkgDir, "extensions"), { recursive: true });
		mkdirSync(join(pkgDir, "prompts"), { recursive: true });
		for (const name of ["a", "b", "c"]) {
			writeFileSync(join(pkgDir, "extensions", `${name}.ts`), "export default function() {}");
			writeFileSync(join(pkgDir, "prompts", `${name}.md`), `${name} prompt`);
		}
		writeFileSync(join(pkgDir, "extensions", "[id].ts"), "export default function() {}");
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({
				name: "globbed",
				pi: { extensions: ["extensions/[ab].ts", "extensions/[id].ts"], prompts: ["prompts/{a,c}.md"] },
			}),
		);
		settingsManager.setPackages([pkgDir]);
		const result = await packageManager.resolve();
		expect(result.extensions.map((r) => r.path.split("/").pop()).sort()).toEqual(["[id].ts", "a.ts", "b.ts"]);
		expect(result.prompts.map((r) => r.path.split("/").pop()).sort()).toEqual(["a.md", "c.md"]);
	});

	// a direct declaration outranks the same file collected from a package.
	it("lets a disabled direct declaration win over the same file exported by a package", async () => {
		const pkgDir = writePackage({ extensions: ["plugin.ts"] });
		const pluginPath = join(pkgDir, "plugin.ts");
		settingsManager.setPackages([pkgDir]);
		settingsManager.setExtensionPaths([pluginPath, `-${pluginPath}`]);
		const result = await packageManager.resolve();
		const plugin = result.extensions.filter((r) => r.path === pluginPath);
		expect(plugin).toHaveLength(1);
		expect(plugin[0].enabled).toBe(false);
		expect(plugin[0].metadata.origin).toBe("top-level");
	});

	it("still lets an enabled direct declaration win over a package that disables the file", async () => {
		const pkgDir = writePackage({ extensions: ["plugin.ts"] });
		const pluginPath = join(pkgDir, "plugin.ts");
		settingsManager.setPackages([{ source: pkgDir, extensions: ["-plugin.ts"] }]);
		settingsManager.setExtensionPaths([pluginPath]);
		const result = await packageManager.resolve();
		const plugin = result.extensions.filter((r) => r.path === pluginPath);
		expect(plugin).toHaveLength(1);
		expect(plugin[0].enabled).toBe(true);
	});
});
