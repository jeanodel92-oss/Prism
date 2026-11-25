// fork: /browser setup as a guided setup with an end to end check, the Firefox copy of the
// extension, and the Computer use domain of /settings. Fake browsers and a scripted user; no real browser here (the
// real extension is checked in fork-browser-e2e.test.ts).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	browserCommand,
	extensionStorePage,
	type FoundBrowser,
	firefoxManifest,
	isInstalledBrowser,
	visibleExtensionRoot,
	writeChromiumExtension,
	writeFirefoxExtension,
} from "../src/fork/browser/setup.ts";
import {
	type LinkedBrowser,
	runBrowserSetup,
	sameBrowser,
	type WizardDeps,
	type WizardScreen,
} from "../src/fork/browser/wizard.ts";
import { SETTINGS_SHORTCUTS } from "../src/fork/settings-descriptions.ts";
import { groupSettingsByDomain } from "../src/fork/settings-domains.ts";

const CHROMIUM: FoundBrowser = { name: "Chromium", family: "chromium", hostsDir: "/h/chromium" };
const FIREFOX: FoundBrowser = { name: "Firefox", family: "firefox", hostsDir: "/h/mozilla" };
const ZEN_FLATPAK: FoundBrowser = { name: "Zen (Flatpak)", family: "firefox", hostsDir: "/h/zen", flatpak: "app.zen" };
const CHROME_STORE = "https://chromewebstore.google.com/detail/prism/oinfdnajckegicaemkaobancehobeghe";
const FIREFOX_STORE = "https://addons.mozilla.org/addon/prism-browser/";

/** A user who answers each screen with the next scripted action, and the screens shown. */
function scriptedUi(answers: Array<string | undefined>) {
	const screens: WizardScreen[] = [];
	return {
		screens,
		ui: {
			async ask(screen: WizardScreen, until?: Promise<string>) {
				screens.push(screen);
				// The waiting screen ends on its own, when the check is done.
				if (screen.id === "waiting" && until) return until;
				return answers.shift();
			},
		},
	};
}

function deps(overrides: Partial<WizardDeps> = {}, linked: () => LinkedBrowser[] = () => []): WizardDeps {
	return {
		browsers: () => [CHROMIUM, FIREFOX],
		declare: (browser) => ({ path: `${browser.hostsDir}/prism.json` }),
		grantFlatpak: vi.fn(),
		extensionDir: (browser) => `/ext/${browser.family}`,
		openBrowser: () => undefined,
		copy: vi.fn(async () => {}),
		linked: async () => linked(),
		check: async () => undefined,
		choose: vi.fn(),
		sleep: async () => {},
		waitMs: 50,
		...overrides,
	};
}

const linkedAs = (name: string, extra: Partial<LinkedBrowser> = {}): LinkedBrowser => ({
	name,
	version: "130.0.1",
	realInput: true,
	stopped: false,
	pid: 1,
	...extra,
});

describe("browser guided setup", () => {
	// The extension is in both stores (accepted 2026-11): the store comes first, the folder stays as a fallback.
	it("guides Chromium through its store, checks it end to end and makes it the agent's browser", async () => {
		let added = false;
		const opened: Array<[string, string | undefined]> = [];
		const setup = deps(
			{
				openBrowser: (browser, url) => {
					opened.push([browser.name, url]);
					return undefined;
				},
			},
			() => (added ? [linkedAs("Chromium")] : []),
		);
		const { ui, screens } = scriptedUi(["0", "open-store", "copy-store", "check", "done"]);
		const copy = setup.copy as ReturnType<typeof vi.fn>;
		copy.mockImplementation(async () => {
			added = true;
		});
		expect(await runBrowserSetup(ui, setup)).toBe("Chromium");
		expect(screens.map((screen) => screen.id)).toEqual([
			"choose",
			"extension",
			"extension",
			"extension",
			"waiting",
			"linked",
		]);
		expect(extensionStorePage("chromium")).toBe(CHROME_STORE);
		const steps = screens[1]!.lines.join("\n");
		expect(steps).toContain(`1. Open the Prism extension's page in Chromium: ${CHROME_STORE}`);
		expect(steps).toContain("2. Choose Add to Chrome, then Add extension.");
		expect(steps).not.toContain("Developer mode");
		expect(screens[1]!.actions.map((action) => action.id)).toEqual(["open-store", "copy-store", "check", "folder"]);
		expect(opened).toEqual([["Chromium", CHROME_STORE]]);
		expect(screens[2]!.lines).toContain("Chromium opened.");
		expect(copy).toHaveBeenCalledWith(CHROME_STORE);
		expect(screens[3]!.lines.join("\n")).toContain(`${CHROME_STORE} copied: paste it in the address bar of Chromium`);
		expect(screens[5]!.lines.join("\n")).toContain("Checked: Prism opened, read and closed a tab");
		expect(setup.choose).toHaveBeenCalledWith("Chromium", CHROMIUM);
	});

	it("says what is in place when the extension never connects, and checks again on demand", async () => {
		let connected = false;
		const setup = deps({}, () => (connected ? [linkedAs("Firefox", { realInput: false })] : []));
		const { ui, screens } = scriptedUi(["1", "check", "retry", "done"]);
		const original = setup.sleep;
		setup.sleep = async (ms) => {
			// Connects during the second wait only.
			if (screens.filter((screen) => screen.id === "waiting").length === 2) connected = true;
			await original(ms);
		};
		expect(await runBrowserSetup(ui, setup)).toBe("Firefox");
		const diagnostics = screens.find((screen) => screen.id === "diagnostics")!;
		expect(diagnostics.errors).toEqual(["The extension did not connect from Firefox."]);
		expect(diagnostics.lines.join("\n")).toContain("Host declared for Firefox: /h/mozilla/prism.json");
		// Installed from the store: the hint names about:addons, not the temporary add-on page.
		expect(diagnostics.lines.join("\n")).toContain("Is the Prism extension in about:addons");
		expect(diagnostics.lines.join("\n")).not.toContain("about:debugging");
		expect(diagnostics.actions.map((action) => action.id)).toEqual(["retry", "steps", "other"]);
		// Firefox: the AMO steps, and the way to real clicks once linked by script.
		const steps = screens.find((screen) => screen.id === "extension")!.lines.join("\n");
		expect(steps).toContain(FIREFOX_STORE);
		expect(steps).toContain("Choose Add to Firefox, then Add.");
		expect(screens.at(-1)!.lines.join("\n")).toContain("/browser firefox");
	});

	// Zen names itself Firefox. Its host from before a reload of the
	// extension made "Firefox" look known, and the wizard waited for Zen until it gave up.
	it("takes a new host of Zen, which names itself Firefox, when an older one was linked at the start", async () => {
		let reloaded = false;
		const checked: number[] = [];
		const setup = deps(
			{
				browsers: () => [ZEN_FLATPAK],
				check: async (pid) => {
					checked.push(pid);
					return undefined;
				},
			},
			() => [linkedAs("Firefox", { realInput: false, pid: reloaded ? 2 : 1 })],
		);
		const { ui, screens } = scriptedUi(["0", "check", "done"]);
		const original = setup.sleep;
		setup.sleep = async (ms) => {
			reloaded = true;
			await original(ms);
		};
		expect(await runBrowserSetup(ui, setup)).toBe("Zen (Flatpak)");
		expect(checked).toEqual([2]);
		expect(screens.map((screen) => screen.id)).toContain("linked");
	});

	it("reports a failed check, and lets the user choose another browser", async () => {
		const setup = deps({ check: async () => "Cannot access about:blank" }, () => [linkedAs("Chromium")]);
		const { ui, screens } = scriptedUi(["0", "check", "other", undefined]);
		expect(await runBrowserSetup(ui, setup)).toBeUndefined();
		const diagnostics = screens.find((screen) => screen.id === "diagnostics")!;
		expect(diagnostics.errors).toEqual(["The extension connected, but the check failed: Cannot access about:blank"]);
		expect(screens.at(-1)!.id).toBe("choose");
		expect(setup.choose).not.toHaveBeenCalled();
	});

	it("asks before letting a Flatpak browser start programs outside its sandbox", async () => {
		const setup = deps({
			browsers: () => [ZEN_FLATPAK],
			declare: (browser) => ({
				path: `${browser.hostsDir}/prism.json`,
				flatpak: { app: "app.zen", hostAccess: false, extra: [] },
			}),
		});
		const { ui, screens } = scriptedUi(["0", "other", undefined]);
		expect(await runBrowserSetup(ui, setup)).toBeUndefined();
		expect(screens[1]!.id).toBe("flatpak");
		expect(screens[1]!.lines.join("\n")).toContain(
			"flatpak override --user --talk-name=org.freedesktop.Flatpak app.zen",
		);
		expect(setup.grantFlatpak).not.toHaveBeenCalled();

		const allowed = scriptedUi(["0", "allow", undefined, undefined]);
		await runBrowserSetup(allowed.ui, setup);
		expect(setup.grantFlatpak).toHaveBeenCalledWith("app.zen", []);
	});

	// Zen (Flatpak) never connected. Probed: its portal pref, the extension folder and ~/.mozilla.
	it("asks for the extra Flatpak grants, tells Zen's portal pref, and grants them", async () => {
		const zen: FoundBrowser = { ...ZEN_FLATPAK, extraHostsDir: "/h/zen-mozilla" };
		const extra = ["--filesystem=/home/u/Prism", "--persist=.mozilla"];
		const setup = deps({
			browsers: () => [zen],
			declare: (browser) => ({
				path: `${browser.hostsDir}/prism.json`,
				flatpak: { app: "app.zen", hostAccess: true, extra },
			}),
		});
		const { ui, screens } = scriptedUi(["0", "allow", undefined, undefined]);
		await runBrowserSetup(ui, setup);
		const consent = screens[1]!.lines.join("\n");
		expect(consent).toContain("flatpak override --user --persist=.mozilla app.zen");
		expect(consent).not.toContain("--talk-name");
		// The store needs no folder: the folder grant waits for the folder path.
		expect(consent).not.toContain("--filesystem");
		expect(setup.grantFlatpak).toHaveBeenCalledWith("app.zen", ["--persist=.mozilla"]);
		const lines = screens[2]!.lines;
		const at = (text: string) => lines.findIndex((line) => line.includes(text));
		expect(at("1. In Zen (Flatpak), open about:config")).toBeGreaterThan(0);
		expect(at("widget.use-xdg-desktop-portal.native-messaging to 0")).toBeGreaterThan(0);
		expect(at("2. Close Zen (Flatpak) completely")).toBeGreaterThan(at("about:config"));
		// A store install survives the restart: no "before adding the extension" here.
		expect(lines.join("\n")).not.toContain("which a restart removes");
		expect(at("3. Open the Prism extension's page in Zen (Flatpak)")).toBeGreaterThan(at("Close Zen"));
		expect(at("4. Choose Add to Firefox")).toBeGreaterThan(at("3. Open"));

		// The folder path asks for the folder, then restart first, add the extension after.
		const folder = scriptedUi(["0", "allow", "folder", "allow", undefined, undefined, undefined]);
		await runBrowserSetup(folder.ui, setup);
		expect(folder.screens.map((screen) => screen.id)).toEqual([
			"choose",
			"flatpak",
			"extension",
			"flatpak-folder",
			"extension-folder",
			"extension",
			"choose",
		]);
		expect(folder.screens[3]!.lines.join("\n")).toContain(
			"flatpak override --user --filesystem=/home/u/Prism app.zen",
		);
		expect(setup.grantFlatpak).toHaveBeenLastCalledWith("app.zen", ["--filesystem=/home/u/Prism"]);
		const folderLines = folder.screens[4]!.lines;
		const atFolder = (text: string) => folderLines.findIndex((line) => line.includes(text));
		expect(atFolder("1. In Zen (Flatpak), open about:config")).toBeGreaterThan(0);
		expect(atFolder("2. Close Zen (Flatpak) completely")).toBeGreaterThan(atFolder("about:config"));
		expect(atFolder("which a restart removes")).toBe(atFolder("2. Close Zen"));
		expect(atFolder("3. In the address bar")).toBeGreaterThan(atFolder("Close Zen"));
		expect(atFolder("4. Choose Load Temporary Add-on")).toBeGreaterThan(atFolder("3. In the address bar"));
	});

	it("asks a Flatpak Firefox for the folder only when the folder is chosen, and returns to the store on refusal", async () => {
		const setup = deps({
			browsers: () => [ZEN_FLATPAK],
			declare: (browser) => ({
				path: `${browser.hostsDir}/prism.json`,
				flatpak: { app: "app.zen", hostAccess: true, extra: ["--filesystem=/home/u/Prism"] },
			}),
		});
		const { ui, screens } = scriptedUi(["0", "folder", "store", undefined, undefined]);
		await runBrowserSetup(ui, setup);
		expect(screens.map((screen) => screen.id)).toEqual([
			"choose",
			"extension",
			"flatpak-folder",
			"extension",
			"choose",
		]);
		expect(setup.grantFlatpak).not.toHaveBeenCalled();
		// Nothing was changed: no restart before the store.
		expect(screens[1]!.lines.join("\n")).not.toContain("Close Zen");
	});

	it("tells a Flatpak browser just granted access to restart before adding the extension", async () => {
		const chromium: FoundBrowser = { ...CHROMIUM, flatpak: "org.chromium.Chromium" };
		const setup = deps({
			browsers: () => [chromium],
			declare: (browser) => ({
				path: `${browser.hostsDir}/prism.json`,
				flatpak: { app: "org.chromium.Chromium", hostAccess: false, extra: [] },
			}),
		});
		const { ui, screens } = scriptedUi(["0", "allow", undefined, undefined]);
		await runBrowserSetup(ui, setup);
		expect(screens[2]!.lines.join("\n")).toContain("1. Close Chromium completely");
		// Nothing changed for a browser already set up: no restart.
		const plain = scriptedUi(["0", undefined, undefined]);
		await runBrowserSetup(plain.ui, deps());
		expect(plain.screens[1]!.lines.join("\n")).not.toContain("Close Chromium");
		expect(plain.screens[1]!.lines.join("\n")).toContain("1. Open the Prism extension's page in Chromium");
	});

	// The folder stays for a browser without the store, and for development. "Open the extensions
	// page" opened Chromium on its New Tab page; and Zen on another page. Every browser opens plainly; the
	// address has a button of its own.
	it("keeps the folder as a fallback: opens the browser plainly, copies the extensions page, back to the store", async () => {
		for (const [index, page, load, folder] of [
			["0", "chrome://extensions", "Choose Load unpacked and select this folder: /ext/chromium", "/ext/chromium"],
			[
				"1",
				"about:debugging#/runtime/this-firefox",
				"Choose Load Temporary Add-on and select manifest.json in this folder: /ext/firefox",
				"/ext/firefox",
			],
		] as const) {
			const opened: Array<string | undefined> = [];
			const setup = deps({
				openBrowser: (_browser, url) => {
					opened.push(url);
					return undefined;
				},
			});
			const { ui, screens } = scriptedUi([
				index,
				"folder",
				"open",
				"copy-page",
				"copy",
				"store",
				undefined,
				undefined,
			]);
			await runBrowserSetup(ui, setup);
			expect(screens.map((screen) => screen.id)).toEqual([
				"choose",
				"extension",
				"extension-folder",
				"extension-folder",
				"extension-folder",
				"extension-folder",
				"extension",
				"choose",
			]);
			const steps = screens[2]!.lines.join("\n");
			expect(steps).toContain(`paste ${page}`);
			expect(steps).toContain(load);
			expect(screens[2]!.actions.map((action) => action.id)).toEqual([
				"open",
				"copy-page",
				"copy",
				"check",
				"store",
			]);
			expect(opened).toEqual([undefined]);
			expect(setup.copy).toHaveBeenCalledWith(page);
			expect(setup.copy).toHaveBeenCalledWith(folder);
			expect(screens[5]!.lines).toContain("Folder path copied.");
		}
		// Escape on the folder steps goes back to the store, not to the list.
		const back = scriptedUi(["0", "folder", undefined, undefined, undefined]);
		await runBrowserSetup(back.ui, deps());
		expect(back.screens.map((screen) => screen.id)).toEqual([
			"choose",
			"extension",
			"extension-folder",
			"extension",
			"choose",
		]);
		const onPath = () => true;
		expect(browserCommand(FIREFOX, onPath)).toEqual(["firefox"]);
		expect(browserCommand(CHROMIUM, onPath)).toEqual(["chromium-browser"]);
		expect(browserCommand(ZEN_FLATPAK, onPath)).toEqual(["flatpak", "run", "app.zen"]);
	});

	it("names the temporary add-on page when a Firefox loaded from the folder does not connect, and keeps its steps", async () => {
		const { ui, screens } = scriptedUi(["1", "folder", "check", "steps", undefined, undefined, undefined]);
		await runBrowserSetup(ui, deps());
		const diagnostics = screens.find((screen) => screen.id === "diagnostics")!;
		expect(diagnostics.lines.join("\n")).toContain("Is the extension in about:debugging?");
		expect(screens[screens.indexOf(diagnostics) + 1]!.id).toBe("extension-folder");
		const folder = screens.find((screen) => screen.id === "extension-folder")!;
		expect(folder.lines.join("\n")).toContain(
			"add it again after a restart, or install the extension from the store",
		);
	});

	// the list offered browsers whose folders stayed after they were removed.
	it("lists only installed browsers: a program on PATH or in a desktop entry, or an installed Flatpak", () => {
		const home = mkdtempSync(join(tmpdir(), "prism-browser-installed-"));
		try {
			const data = join(home, "data");
			mkdirSync(join(data, "applications"), { recursive: true });
			const none = (_program: string) => false;
			const installed = (browser: FoundBrowser, onPath = none) =>
				isInstalledBrowser(browser, { onPath, home, dataDirs: [data] });
			expect(installed(FIREFOX)).toBe(false);
			expect(installed(FIREFOX, (program) => program === "firefox")).toBe(true);
			const zen: FoundBrowser = { name: "Zen", family: "firefox", hostsDir: "/h/zen" };
			expect(installed(zen)).toBe(false);
			writeFileSync(join(data, "applications", "zen.desktop"), "[Desktop Entry]\nExec=/opt/zen/zen %u\n");
			expect(installed(zen)).toBe(true);
			expect(installed(ZEN_FLATPAK)).toBe(false);
			mkdirSync(join(home, ".local/share/flatpak/app/app.zen"), { recursive: true });
			expect(installed(ZEN_FLATPAK)).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("says when the extensions page could not be opened, and when no browser is found", async () => {
		const failing = deps({
			openBrowser: () => "Prism did not find Chromium's program: open it yourself.",
		});
		const { ui, screens } = scriptedUi(["0", "open-store", undefined, undefined]);
		await runBrowserSetup(ui, failing);
		expect(screens[2]!.errors).toEqual(["Prism did not find Chromium's program: open it yourself."]);

		const none = scriptedUi([]);
		expect(await runBrowserSetup(none.ui, deps({ browsers: () => [] }))).toBeUndefined();
		expect(none.screens[0]!.lines[0]).toContain("No supported browser found");
	});

	it("matches a linked browser with the one chosen in the list", () => {
		expect(sameBrowser("Chromium", "Chromium")).toBe(true);
		expect(sameBrowser("Zen", "Zen (Flatpak)")).toBe(true);
		expect(sameBrowser("Firefox", "Chromium")).toBe(false);
	});
});

describe("Firefox copy of the extension", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("drops Chromium's key and debugger permission and runs a background script", () => {
		const manifest = firefoxManifest({
			key: "abc",
			permissions: ["nativeMessaging", "debugger", "tabs"],
			background: { service_worker: "background.js", scripts: ["background.js"] },
			name: "Prism",
		});
		expect(manifest).toEqual({
			name: "Prism",
			permissions: ["nativeMessaging", "tabs"],
			background: { scripts: ["background.js"] },
		});
	});

	// a file picker cannot reach a hidden folder or a long path in /tmp.
	it("keeps the Chromium copy, key included, in a visible folder, and refreshes it", () => {
		dir = mkdtempSync(join(tmpdir(), "prism-chromium-ext-"));
		const source = join(dir, "source");
		mkdirSync(source);
		writeFileSync(join(source, "manifest.json"), JSON.stringify({ key: "k", version: "1" }));
		writeFileSync(join(source, "old.js"), "// old");
		const root = join(dir, "home", "Prism");
		const written = writeChromiumExtension(root, source);
		expect(written).toBe(join(root, "browser-extension"));
		expect(JSON.parse(readFileSync(join(written, "manifest.json"), "utf8"))).toEqual({ key: "k", version: "1" });
		rmSync(join(source, "old.js"));
		writeFileSync(join(source, "manifest.json"), JSON.stringify({ key: "k", version: "2" }));
		writeChromiumExtension(root, source);
		expect(JSON.parse(readFileSync(join(written, "manifest.json"), "utf8")).version).toBe("2");
		expect(existsSync(join(written, "old.js"))).toBe(false);
		const folder = visibleExtensionRoot("/home/u");
		expect(folder).toBe("/home/u/Prism");
		expect(folder.split("/").some((part) => part.startsWith("."))).toBe(false);
	});

	it("writes a copy in a visible folder and leaves the source untouched", () => {
		dir = mkdtempSync(join(tmpdir(), "prism-firefox-ext-"));
		const source = join(dir, "source");
		mkdirSync(source);
		const original = JSON.stringify({ key: "k", permissions: ["debugger"], background: { service_worker: "b.js" } });
		writeFileSync(join(source, "manifest.json"), original);
		writeFileSync(join(source, "background.js"), "// script");
		const written = writeFirefoxExtension(join(dir, "Prism"), source);
		expect(written).toBe(join(dir, "Prism", "browser-extension-firefox"));
		expect(JSON.parse(readFileSync(join(written, "manifest.json"), "utf8"))).toEqual({
			permissions: [],
			background: { scripts: ["background.js"] },
		});
		expect(readFileSync(join(written, "background.js"), "utf8")).toBe("// script");
		expect(readFileSync(join(source, "manifest.json"), "utf8")).toBe(original);
	});
});

describe("Settings > Computer use", () => {
	it("holds the computer use modules and the browser's setup, apart from the other modules", () => {
		const model = groupSettingsByDomain([], vi.fn(), {
			builtinExtensions: [
				{ name: "browser", enabled: false },
				{ name: "desktop", enabled: false },
				{ name: "user-desktop", enabled: false },
				{ name: "memory", enabled: true },
			],
			onBuiltinExtensionChange: vi.fn(),
			commands: SETTINGS_SHORTCUTS.filter((entry) => entry.command === "browser setup"),
			sections: () => [],
		});
		const ids = (id: string) =>
			model
				.domains()
				.find((domain) => domain.id === id)
				?.items()
				.map((item) => item.id);
		expect(ids("computer-use")).toEqual([
			"builtin:browser",
			"builtin:desktop",
			"builtin:user-desktop",
			"command:browser setup",
		]);
		expect(ids("modules")).toEqual(["builtin:memory"]);
		const run = vi.fn();
		const withRun = groupSettingsByDomain([], vi.fn(), {
			builtinExtensions: [{ name: "browser", enabled: true }],
			onBuiltinExtensionChange: vi.fn(),
			commands: SETTINGS_SHORTCUTS.filter((entry) => entry.command === "browser setup"),
			onRunCommand: run,
			sections: () => [],
		});
		void withRun.onChange("command:browser setup", "open");
		expect(run).toHaveBeenCalledWith("browser setup", { domain: "computer-use", item: "command:browser setup" });
	});
});
