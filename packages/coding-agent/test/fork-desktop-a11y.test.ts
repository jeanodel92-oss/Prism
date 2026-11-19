// the accessibility tree of the agent's desktop end to end: a real headless labwc, the real helper, its
// own session and accessibility buses, and GNOME Calculator (GTK4) shown on it.
// Throwaway HOME; skipped when labwc, the helper's build tools, D-Bus, the registry, libatspi or the calculator are
// missing.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { emitSessionShutdownEvent } from "../src/core/extensions/runner.ts";
import desktopExtension, { launchOnDesktop } from "../src/fork/desktop/index.ts";
import { AgentDesktop } from "../src/fork/desktop/session.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult } from "./suite/harness.ts";
import { stubThrowawayHome } from "./suite/throwaway-home.ts";

function which(command: string): string | undefined {
	try {
		return execFileSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

function hasLibrary(name: string): boolean {
	try {
		return execFileSync("sh", ["-c", "ldconfig -p 2>/dev/null || /sbin/ldconfig -p"], { encoding: "utf8" }).includes(
			name,
		);
	} catch {
		return false;
	}
}

const labwc = which("labwc");
const calculator = which("gnome-calculator");
const firefox = which("firefox");
const registry = [
	"/usr/libexec/at-spi2-registryd",
	"/usr/lib/at-spi2-registryd",
	"/usr/lib/at-spi2-core/at-spi2-registryd",
].find((path) => existsSync(path));
const ready = Boolean(labwc && which("dbus-daemon") && registry && hasLibrary("libatspi.so.0"));
const gtk3 = (() => {
	try {
		execFileSync("python3", ["-c", "import gi; gi.require_version('Gtk','3.0'); from gi.repository import Gtk"], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
})();
const webkitPage = fileURLToPath(new URL("./fixtures/fork-webkit-page.py", import.meta.url));
const gtkFields = fileURLToPath(new URL("./fixtures/fork-gtk-fields.py", import.meta.url));
const gtk4Menu = fileURLToPath(new URL("./fixtures/fork-gtk4-menu.py", import.meta.url));
const gtk4 = (() => {
	try {
		execFileSync("python3", ["-c", "import gi; gi.require_version('Gtk','4.0'); from gi.repository import Gtk"], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
})();
const libreoffice = which("soffice");
const webkit = (() => {
	try {
		execFileSync(
			"python3",
			[
				"-c",
				"import gi; gi.require_version('Gtk','3.0'); gi.require_version('WebKit2','4.1'); from gi.repository import WebKit2",
			],
			{ stdio: "ignore" },
		);
		return true;
	} catch {
		return false;
	}
})();
const buildScript = fileURLToPath(new URL("../../../fork/desktop-helper/build.sh", import.meta.url));
let helper: string | undefined;
let helperDir: string | undefined;

beforeAll(() => {
	if (labwc && which("gcc") && which("wayland-scanner")) {
		helperDir = mkdtempSync(join(tmpdir(), "prism-a11y-helper-"));
		try {
			execFileSync(buildScript, [helperDir], { stdio: "pipe" });
			helper = join(helperDir, "prism-desktop-helper");
		} catch {
			helper = undefined;
		}
	}
}, 60000);

afterAll(() => {
	if (helperDir) rmSync(helperDir, { recursive: true, force: true });
});

describe.skipIf(!labwc)("accessibility tree of the agent's desktop", () => {
	it("is refused without the desktop's own accessibility bus, never read from the user's; programs keep its session bus", async (context) => {
		if (!helper) context.skip();
		const desktop = await AgentDesktop.start({ helper: helper!, registry: false });
		try {
			// Owner, 2026-11-12: programs still get the desktop's own session bus, not the user's.
			if (which("dbus-daemon")) {
				expect(desktop.programEnv).toEqual({
					DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(desktop.runtimeDir, "bus")}`,
				});
				expect(existsSync(join(desktop.runtimeDir, "bus"))).toBe(true);
				expect(existsSync(join(desktop.runtimeDir, "a11y-bus"))).toBe(false);
				if (which("gdbus")) {
					const base = mkdtempSync(join(tmpdir(), "prism-desktop-bus-"));
					try {
						const launched = await launchOnDesktop(
							"gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.GetId",
							base,
							join(base, "launch.log"),
							desktop.programEnv,
						);
						await launched.group.ended;
						expect(launched.output).toMatch(/^\('[0-9a-f]{32}',\)/);
					} finally {
						rmSync(base, { recursive: true, force: true });
					}
				}
			} else {
				expect(desktop.programEnv).toEqual({});
			}
			await expect(desktop.elements()).rejects.toThrow(/accessibility tree is not available.*registry/);
			// The helper itself refuses: without PRISM_A11Y, libatspi would find the user's accessibility bus.
			await expect(desktop.request(`elements ${join(desktop.runtimeDir, "x.tsv")}`)).rejects.toThrow(
				"this desktop has no accessibility bus of its own",
			);
		} finally {
			desktop.stop();
		}
	}, 30000);

	it.skipIf(!ready || !calculator)(
		"lists a program's elements and acts on them by reference, with no screen position",
		async (context) => {
			if (!helper) context.skip();
			const base = mkdtempSync(join(tmpdir(), "prism-desktop-a11y-"));
			mkdirSync(join(base, "home"));
			stubThrowawayHome(join(base, "home"));
			vi.stubEnv(ENV_AGENT_DIR, join(base, "agent"));
			vi.stubEnv("PRISM_DESKTOP_HELPER", helper!);
			// Set in the user's session, it would keep GTK programs out of the tree.
			vi.stubEnv("NO_AT_BRIDGE", "1");
			const harness = await createHarness({ extensionFactories: [{ name: "desktop", factory: desktopExtension }] });
			try {
				await harness.session.bindExtensions({ uiContext: createTestUiContext() });
				const call = async (input: JsonObject) => {
					harness.setResponses([
						fauxAssistantMessage(fauxToolCall("desktop", input), { stopReason: "toolUse" }),
						fauxAssistantMessage("done"),
					]);
					await harness.session.prompt("go");
					const result = getToolResult(harness, "desktop");
					return { text: getMessageText(result), isError: result.isError === true };
				};
				// Programs get the desktop's own buses, without the user's NO_AT_BRIDGE.
				const env = await call({
					action: "launch",
					command:
						'echo "a11y=$AT_SPI_BUS_ADDRESS session=$DBUS_SESSION_BUS_ADDRESS bridge=$(printenv NO_AT_BRIDGE || echo none)"',
				});
				expect(env.text).toMatch(
					/a11y=unix:path=\S*prism-desk-\w+\/a11y-bus session=unix:path=\S*prism-desk-\w+\/bus/,
				);
				expect(env.text).toContain("bridge=none");

				expect((await call({ action: "launch", command: "gnome-calculator" })).isError).toBe(false);
				let listing = "";
				const deadline = Date.now() + 20000;
				while (!/button "7"/.test(listing) && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 300));
					listing = (await call({ action: "elements" })).text;
				}
				expect(listing).toMatch(/^Window "Calculator" \(gnome-calculator, in front\):/m);
				const ref = (label: string, text = listing) =>
					new RegExp(`(e\\d+) button "${label.replace(/[+]/g, "\\$&")}"`).exec(text)?.[1];
				const seven = ref("7");
				for (const label of ["7", "+", "2", "="]) {
					const done = await call({ action: "click", ref: ref(label)! });
					expect(done).toEqual({ text: `Done: click on ${ref(label)}.`, isError: false });
				}
				// The program shows the result on its next turn.
				const shown = Date.now() + 5000;
				do listing = (await call({ action: "elements" })).text;
				while (!listing.includes('label "9"') && Date.now() < shown);
				expect(listing).toContain('label "7+2"');
				expect(listing).toContain('label "9"');
				// A reference of an older listing is refused, never taken for another element.
				expect(await call({ action: "click", ref: seven! })).toEqual({
					text: "unknown or stale element: list the elements again",
					isError: true,
				});

				// Typed into a field of the window in front.
				const field = /(e\d+) text \[(?:focused, )?editable\]/.exec(listing)?.[1];
				expect(field, listing).toBeDefined();
				expect(await call({ action: "key", key: "Escape" })).toMatchObject({ isError: false });
				expect(await call({ action: "type", ref: field!, text: "12" })).toEqual({
					text: "Done: type.",
					isError: false,
				});
				const typed = Date.now() + 5000;
				do listing = (await call({ action: "elements" })).text;
				while (!/editable\]: 12$/m.test(listing) && Date.now() < typed);
				expect(listing).toMatch(/e\d+ text \[[^\]]*editable\]: 12$/m);
				expect(await call({ action: "click", ref: "seven" })).toEqual({
					text: 'Unknown ref "seven": use e12 from elements.',
					isError: true,
				});

				// A window in front with no tree (LibreOffice's welcome dialog, here GTK 3 without its bridge): only the
				// compositor lists it, and typing into the calculator by reference is refused, never sent to it.
				if (gtk3) {
					await call({
						action: "launch",
						command: `NO_AT_BRIDGE=1 python3 -c "import gi; gi.require_version('Gtk','3.0'); from gi.repository import Gtk; w = Gtk.Window(title='No tree'); w.connect('destroy', Gtk.main_quit); w.show_all(); Gtk.main()"`,
					});
					const front = Date.now() + 10000;
					do listing = (await call({ action: "elements" })).text;
					while (!listing.includes('"No tree"') && Date.now() < front);
					expect(listing).toMatch(
						/^Window "No tree" \(\S+, in front\): it shows no elements; use a screenshot\.$/m,
					);
					expect(listing).toMatch(/^Window "Calculator" \(gnome-calculator\):$/m);
					const behind = /(e\d+) text \[[^\]]*editable\]/.exec(listing)?.[1];
					expect(await call({ action: "type", ref: behind!, text: "5" })).toEqual({
						text: 'the window in front is "No tree": deal with it first, or click inside this element\'s window',
						isError: true,
					});
				}
			} finally {
				await emitSessionShutdownEvent(harness.session.extensionRunner, {
					type: "session_shutdown",
					reason: "quit",
				});
				harness.cleanup();
				vi.unstubAllEnvs();
				rmSync(base, { recursive: true, force: true });
			}
		},
		90000,
	);

	it.skipIf(!ready || !gtk3)(
		"replaces a field's whole text, line breaks kept, and says when a text was cut",
		async (context) => {
			if (!helper) context.skip();
			const base = mkdtempSync(join(tmpdir(), "prism-desktop-fields-"));
			mkdirSync(join(base, "home"));
			stubThrowawayHome(join(base, "home"));
			vi.stubEnv(ENV_AGENT_DIR, join(base, "agent"));
			vi.stubEnv("PRISM_DESKTOP_HELPER", helper!);
			const notes = join(base, "notes.txt");
			const harness = await createHarness({ extensionFactories: [{ name: "desktop", factory: desktopExtension }] });
			try {
				await harness.session.bindExtensions({ uiContext: createTestUiContext() });
				const call = async (input: JsonObject) => {
					harness.setResponses([
						fauxAssistantMessage(fauxToolCall("desktop", input), { stopReason: "toolUse" }),
						fauxAssistantMessage("done"),
					]);
					await harness.session.prompt("go");
					const result = getToolResult(harness, "desktop");
					return { text: getMessageText(result), isError: result.isError === true };
				};
				await call({ action: "launch", command: `python3 ${gtkFields} ${notes}` });
				let listing = "";
				const deadline = Date.now() + 20000;
				while (!/"Notes"/.test(listing) && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 300));
					listing = (await call({ action: "elements" })).text;
				}
				const ref = (name: string, text = listing) => new RegExp(`(e\\d+) text "${name}"`).exec(text)?.[1];
				expect(listing).toMatch(/text "File name" \[[^\]]*editable[^\]]*\]: pain lait oeufs\.txt$/m);
				// The long field: cut at 300 characters, and the model told so.
				expect(listing).toContain(`: ${"x".repeat(300)}…`);
				expect(listing).toContain("A name or text ending with … was cut (names at 100 characters, texts at 300)");

				// The text editor trial of 2026-11-12: typing into a field that held a name kept its end.
				expect(await call({ action: "type", ref: ref("File name")!, replace: true, text: "courses.txt" })).toEqual({
					text: `Done: the text of ${ref("File name")} replaced.`,
					isError: false,
				});
				expect(
					await call({ action: "type", ref: ref("Notes")!, replace: true, text: "pain\nlait\r\nœufs \\o/" }),
				).toMatchObject({
					isError: false,
				});
				expect(readFileSync(notes, "utf8")).toBe("pain\nlait\nœufs \\o/");
				listing = (await call({ action: "elements" })).text;
				// Its line breaks reach the model.
				expect(listing).toContain(": pain\\nlait\\nœufs \\\\o/");
				expect(listing).toContain("In a text, \\n is a line break and \\\\ a backslash.");
				expect(listing).toMatch(/text "File name" \[[^\]]*\]: courses\.txt$/m);
				expect(await call({ action: "type", replace: true, text: "x" })).toEqual({
					text: "replace needs the ref of a field.",
					isError: true,
				});
			} finally {
				await emitSessionShutdownEvent(harness.session.extensionRunner, {
					type: "session_shutdown",
					reason: "quit",
				});
				harness.cleanup();
				vi.unstubAllEnvs();
				rmSync(base, { recursive: true, force: true });
			}
		},
		90000,
	);

	it.skipIf(!ready || !webkit)(
		"lists a WebKitGTK page, as in the Prism window, through the wrappers that do not say they are shown",
		async (context) => {
			if (!helper) context.skip();
			const base = mkdtempSync(join(tmpdir(), "prism-desktop-webkit-"));
			mkdirSync(join(base, "home"));
			stubThrowawayHome(join(base, "home"));
			vi.stubEnv(ENV_AGENT_DIR, join(base, "agent"));
			vi.stubEnv("PRISM_DESKTOP_HELPER", helper!);
			const harness = await createHarness({ extensionFactories: [{ name: "desktop", factory: desktopExtension }] });
			try {
				await harness.session.bindExtensions({ uiContext: createTestUiContext() });
				const call = async (input: JsonObject) => {
					harness.setResponses([
						fauxAssistantMessage(fauxToolCall("desktop", input), { stopReason: "toolUse" }),
						fauxAssistantMessage("done"),
					]);
					await harness.session.prompt("go");
					return getMessageText(getToolResult(harness, "desktop"));
				};
				await call({ action: "launch", command: `python3 ${webkitPage}` });
				let listing = "";
				const deadline = Date.now() + 30000;
				while (!/button "Ping"/.test(listing) && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 500));
					listing = await call({ action: "elements" });
				}
				expect(listing).toMatch(/^Window "Web page"/m);
				expect(listing).toMatch(/e\d+ +button "Ping"/);
				expect(listing).toMatch(/e\d+ +entry "Name" \[[^\]]*editable/);
			} finally {
				await emitSessionShutdownEvent(harness.session.extensionRunner, {
					type: "session_shutdown",
					reason: "quit",
				});
				harness.cleanup();
				vi.unstubAllEnvs();
				rmSync(base, { recursive: true, force: true });
			}
		},
		90000,
	);

	it.skipIf(!ready || !firefox)(
		"lists the rows of a Firefox page that a scroll brought on screen, not the ones it took off",
		async (context) => {
			if (!helper) context.skip();
			const base = mkdtempSync(join(tmpdir(), "prism-desktop-firefox-"));
			mkdirSync(join(base, "home"));
			stubThrowawayHome(join(base, "home"));
			vi.stubEnv(ENV_AGENT_DIR, join(base, "agent"));
			vi.stubEnv("PRISM_DESKTOP_HELPER", helper!);
			const rows = Array.from({ length: 80 }, (_, i) => `<tr><td>row-${i + 1}</td></tr>`).join("");
			writeFileSync(join(base, "page.html"), `<!doctype html><title>Rows</title><table>${rows}</table>`);
			const harness = await createHarness({ extensionFactories: [{ name: "desktop", factory: desktopExtension }] });
			try {
				await harness.session.bindExtensions({ uiContext: createTestUiContext() });
				const call = async (input: JsonObject) => {
					harness.setResponses([
						fauxAssistantMessage(fauxToolCall("desktop", input), { stopReason: "toolUse" }),
						fauxAssistantMessage("done"),
					]);
					await harness.session.prompt("go");
					return getMessageText(getToolResult(harness, "desktop"));
				};
				await call({ action: "launch", command: `firefox --new-instance file://${join(base, "page.html")}` });
				let listing = "";
				const loaded = Date.now() + 40000;
				while (!/cell "row-1"/.test(listing) && Date.now() < loaded) {
					await new Promise((resolve) => setTimeout(resolve, 500));
					listing = await call({ action: "elements" });
				}
				expect(listing).toMatch(/cell "row-1"/);
				expect(listing).not.toMatch(/cell "row-70"/);
				// Firefox kept the rows' "showing" state as first read: after this scroll the listing was unchanged.
				await call({ action: "key", key: "End" });
				const scrolled = Date.now() + 5000;
				do listing = await call({ action: "elements" });
				while (!/cell "row-80"/.test(listing) && Date.now() < scrolled);
				expect(listing).toMatch(/cell "row-80"/);
				expect(listing).not.toMatch(/cell "row-1"/);
			} finally {
				await emitSessionShutdownEvent(harness.session.extensionRunner, {
					type: "session_shutdown",
					reason: "quit",
				});
				harness.cleanup();
				vi.unstubAllEnvs();
				rmSync(base, { recursive: true, force: true });
			}
		},
		90000,
	);
	/** A harness whose desktop tool calls return the text and whether it failed. */
	async function toolSession(prefix: string) {
		const base = mkdtempSync(join(tmpdir(), prefix));
		mkdirSync(join(base, "home"));
		stubThrowawayHome(join(base, "home"));
		vi.stubEnv(ENV_AGENT_DIR, join(base, "agent"));
		vi.stubEnv("PRISM_DESKTOP_HELPER", helper!);
		const harness = await createHarness({ extensionFactories: [{ name: "desktop", factory: desktopExtension }] });
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		const call = async (input: JsonObject) => {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("desktop", input), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			const result = getToolResult(harness, "desktop");
			return { text: getMessageText(result), isError: result.isError === true };
		};
		const until = async (pattern: RegExp, timeout: number) => {
			let listing = "";
			const deadline = Date.now() + timeout;
			while (!pattern.test(listing) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 500));
				listing = (await call({ action: "elements" })).text;
			}
			return listing;
		};
		const end = async () => {
			await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
			harness.cleanup();
			vi.unstubAllEnvs();
			rmSync(base, { recursive: true, force: true });
		};
		return { call, until, end };
	}

	it.skipIf(!ready || !gtk4)(
		"names GTK 4 menu items by their label (computer-use trials, 2026-11-12)",
		async (context) => {
			if (!helper) context.skip();
			const { call, until, end } = await toolSession("prism-desktop-gtk4-");
			try {
				await call({ action: "launch", command: `python3 ${gtk4Menu}` });
				let listing = await until(/toggle button "Main menu"/, 20000);
				const button = /(e\d+) toggle button "Main menu"/.exec(listing)?.[1];
				expect(button, listing).toBeDefined();
				expect((await call({ action: "click", ref: button! })).isError).toBe(false);
				listing = await until(/menu item "Preferences"/, 5000);
				expect(listing).toMatch(/e\d+ menu item "Open File"/);
				expect(listing).toMatch(/e\d+ menu item "Save As…"/);
				expect(listing).toMatch(/e\d+ menu item "Preferences"/);
				expect(listing).not.toMatch(/menu item(?: \[[^\]]*\])?$/m);
			} finally {
				await end();
			}
		},
		90000,
	);

	it.skipIf(!ready || !libreoffice)(
		"lists a Calc sheet by the cells on the screen, quickly and whole (computer-use trials, 2026-11-12)",
		async (context) => {
			if (!helper) context.skip();
			const { call, until, end } = await toolSession("prism-desktop-calc-");
			try {
				await call({ action: "launch", command: "soffice --calc --norestore" });
				await until(/table "Sheet Sheet1"/, 60000);
				// A new profile opens a welcome dialog about a second after the sheet: wait for it, then its Next
				// buttons, then Close.
				let listing = await until(/Window "Welcome to LibreOffice!"/, 15000);
				for (let i = 0; i < 8 && listing.includes('Window "Welcome to LibreOffice!"'); i++) {
					const dialog = listing.slice(listing.indexOf('Window "Welcome to LibreOffice!"'));
					const button =
						/(e\d+) button "Close"/.exec(dialog)?.[1] ?? /(e\d+) button "Next"/.exec(dialog)?.[1] ?? undefined;
					if (!button) break;
					await call({ action: "click", ref: button });
					await new Promise((resolve) => setTimeout(resolve, 1000));
					listing = (await call({ action: "elements" })).text;
				}
				expect(listing).not.toContain("Welcome to LibreOffice!");
				expect((await call({ action: "type", text: "3\n7\n" })).isError).toBe(false);
				const typed = Date.now() + 5000;
				do listing = (await call({ action: "elements" })).text;
				while (!/table cell "A2"/.test(listing) && Date.now() < typed);
				const started = Date.now();
				listing = (await call({ action: "elements" })).text;
				// It read 16 384 cells a row: 5 to 8 s, and the listing stopped after row 2.
				expect(Date.now() - started).toBeLessThan(3000);
				expect(listing).toMatch(
					/table "Sheet Sheet1" \[[^\]]*\]: 1048576 rows and 16384 columns; cells of rows 1 to \d+ and columns 1 to \d+ listed \(on the screen\), those without text left out/,
				);
				expect(listing).toMatch(/e\d+ +table cell "A1" \[[^\]]*\]: 3$/m);
				expect(listing).toMatch(/e\d+ +table cell "A2" \[[^\]]*\]: 7$/m);
				expect(listing).toMatch(/table cell "A3" \[[^\]]*focused/);
				expect(listing).not.toMatch(/table cell "B1"/);
				expect(listing).toMatch(/button "Sort Ascending"/);
				expect(listing).not.toContain("Some elements were left out");
			} finally {
				await end();
			}
		},
		150000,
	);
});
