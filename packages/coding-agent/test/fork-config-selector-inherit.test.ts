/**
 * fork: in `prism config`, a resource changed globally is inherited in its
 * new state when the project tab is opened. The project tab kept the state read when the selector opened, and cycled
 * the project override from it.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.ts";

describe("fork: the project tab inherits the global change", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	beforeEach(() => {
		tempDir = join(tmpdir(), `prism-config-inherit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function open(globalExtensions: string[]) {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ extensions: globalExtensions }));
		const settingsManager = SettingsManager.fromStorage(storage, { projectTrusted: true });
		const resolvedPaths = await new DefaultPackageManager({
			cwd: projectDir,
			agentDir,
			settingsManager,
			builtinExtensions: ["mcp"],
		}).resolve();
		const selector = new ConfigSelectorComponent(
			{ global: resolvedPaths, project: resolvedPaths },
			settingsManager,
			projectDir,
			agentDir,
			() => {},
			() => {},
			() => {},
			24,
			"global",
		);
		return { list: selector.getResourceList(), settingsManager };
	}

	it("enabled globally, then the project tab: the first press unloads it for the project", async () => {
		const { list, settingsManager } = await open(["-builtin:mcp"]);
		list.handleInput(" ");
		expect(settingsManager.getGlobalSettings().extensions).toEqual(["+builtin:mcp"]);
		list.handleInput("\t");
		list.handleInput(" ");
		expect(settingsManager.getProjectSettings().extensions).toEqual(["-builtin:mcp"]);
	});

	it("disabled globally, then the project tab: the first press loads it for the project", async () => {
		const { list, settingsManager } = await open([]);
		list.handleInput(" ");
		expect(settingsManager.getGlobalSettings().extensions).toEqual(["-builtin:mcp"]);
		list.handleInput("\t");
		list.handleInput(" ");
		expect(settingsManager.getProjectSettings().extensions).toEqual(["+builtin:mcp"]);
	});
});
