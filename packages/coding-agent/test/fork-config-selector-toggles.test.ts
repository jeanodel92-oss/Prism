/**
 * fork: `prism config` toggles, checked by resolving the settings again.
 * - an exclusion written in another form of the same path (absolute, "./") stayed next to the new "+" entry
 *   and won: the box said on, the extension stayed off.
 * - turning one file of a package on or off rewrote the package's list so that its other files changed too,
 *   and turning off a file listed outside the automatic folders dropped the entry it was found by.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager, type ResolvedPaths } from "../src/core/package-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.ts";

type Item = { path: string; enabled: boolean };
type List = {
	flatItems: Array<{ type: string; item?: Item }>;
	toggleResource(item: Item): boolean | undefined;
};

describe("fork: config toggles match what loads", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	beforeEach(() => {
		tempDir = join(tmpdir(), `prism-config-toggles-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		mkdirSync(projectDir, { recursive: true });
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	const file = (path: string) => {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "export default function () {}\n");
		return path;
	};

	async function setup(settings: object) {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify(settings));
		const settingsManager = SettingsManager.fromStorage(storage, { projectTrusted: true });
		const resolve = () => new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager }).resolve();
		const enabled = async (path: string) =>
			(await resolve()).extensions.find((resource) => resource.path === path)?.enabled;
		const toggle = async (path: string) => {
			const resolved: ResolvedPaths = await resolve();
			const selector = new ConfigSelectorComponent(
				{ global: resolved, project: resolved },
				settingsManager,
				projectDir,
				agentDir,
				() => {},
				() => {},
				() => {},
				24,
				"global",
			);
			const list = selector.getResourceList() as unknown as List;
			const item = list.flatItems.find((entry) => entry.item?.path === path)?.item;
			expect(item, path).toBeDefined();
			list.toggleResource(item!);
		};
		return { settingsManager, enabled, toggle };
	}

	it("245: turning on an extension excluded by its absolute path, or with ./, loads it", async () => {
		const foo = file(join(agentDir, "extensions", "foo.ts"));
		const bar = file(join(agentDir, "extensions", "bar.ts"));
		const { enabled, toggle, settingsManager } = await setup({ extensions: [`-${foo}`, "-./extensions/bar.ts"] });
		expect(await enabled(foo)).toBe(false);
		expect(await enabled(bar)).toBe(false);
		await toggle(foo);
		await toggle(bar);
		expect(await enabled(foo)).toBe(true);
		expect(await enabled(bar)).toBe(true);
		expect(settingsManager.getGlobalSettings().extensions).toEqual(["+extensions/foo.ts", "+extensions/bar.ts"]);
	});

	it("246: turning on one file of a package that loads none leaves the other off", async () => {
		const pkg = join(tempDir, "pkg");
		const a = file(join(pkg, "extensions", "A.ts"));
		const b = file(join(pkg, "extensions", "B.ts"));
		const { enabled, toggle } = await setup({ packages: [{ source: pkg, extensions: [] }] });
		expect(await enabled(a)).toBe(false);
		await toggle(a);
		expect(await enabled(a)).toBe(true);
		expect(await enabled(b)).toBe(false);
		await toggle(a);
		expect(await enabled(a)).toBe(false);
		expect(await enabled(b)).toBe(false);
	});

	it("246: turning off the only file a package's list loads leaves the others off", async () => {
		const pkg = join(tempDir, "pkg");
		const a = file(join(pkg, "extensions", "A.ts"));
		const b = file(join(pkg, "extensions", "B.ts"));
		const { enabled, toggle } = await setup({ packages: [{ source: pkg, extensions: ["extensions/A.ts"] }] });
		expect(await enabled(a)).toBe(true);
		expect(await enabled(b)).toBe(false);
		await toggle(a);
		expect(await enabled(a)).toBe(false);
		expect(await enabled(b)).toBe(false);
	});

	it("246: a file listed outside the automatic folders stays listed when turned off, and comes back on", async () => {
		const shared = file(join(tempDir, "shared", "foo.ts"));
		const { enabled, toggle, settingsManager } = await setup({ extensions: ["../shared/foo.ts"] });
		expect(await enabled(shared)).toBe(true);
		await toggle(shared);
		expect(await enabled(shared)).toBe(false);
		await toggle(shared);
		expect(await enabled(shared)).toBe(true);
		expect(settingsManager.getGlobalSettings().extensions).toEqual(["../shared/foo.ts", "+../shared/foo.ts"]);
	});
});
