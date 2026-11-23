/**
 * fork: `/browser setup` as a guided setup, one step after the other, in the window (native
 * screens) and in the terminal (dialogs): choose the browser, declare Prism's host to it, add the extension (from its
 * add-on store first: the store page opened in the browser or its address copied; or, for a browser without the store,
 * from the folder Prism wrote: its extensions page's address and the folder copied), then a check from end to end, a
 * tab opened, read and closed through the extension. When it fails, the screen says what is in place and what is not.
 * Linking another browser later makes it the one the agent uses (hot switch): the choice is saved, and each session's
 * last browser forgotten.
 */
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { fill, t } from "../i18n/index.ts";
import { NativeFlow, showNativeFlow } from "../native-flow.ts";
import { extensionStorePage, extensionsPage, type FoundBrowser } from "./setup.ts";

export interface WizardAction {
	id: string;
	label: string;
	description?: string;
}

export interface WizardScreen {
	id: string;
	title: string;
	lines: string[];
	errors?: string[];
	actions: WizardAction[];
}

export interface WizardUi {
	/** Shows a screen: the chosen action's id, undefined on Back or Close, or `until`'s value if it comes first. */
	ask(screen: WizardScreen, until?: Promise<string>): Promise<string | undefined>;
}

export interface LinkedBrowser {
	name: string;
	version: string;
	realInput: boolean;
	stopped: boolean;
	/** Its host's process. Hosts are told apart by it: Zen names itself Firefox, like a real Firefox. */
	pid: number;
}

export interface WizardDeps {
	browsers(): FoundBrowser[];
	/** Declares the host to the browser: the declaration's path, and for a Flatpak one whether it may leave its sandbox. */
	declare(browser: FoundBrowser): {
		path: string;
		flatpak?: { app: string; hostAccess: boolean; extra: string[] };
	};
	grantFlatpak(app: string, extra: readonly string[]): void;
	extensionDir(browser: FoundBrowser): string;
	/** Opens the browser, on `url` when given: undefined, or why it could not. */
	openBrowser(browser: FoundBrowser, url?: string): string | undefined;
	copy(text: string): Promise<void>;
	linked(): Promise<LinkedBrowser[]>;
	/** A tab opened, read and closed in that browser through the extension: undefined, or what failed. */
	check(pid: number): Promise<string | undefined>;
	/** Makes it the browser the agent uses. */
	choose(name: string): void;
	sleep(ms: number): Promise<void>;
	/** How long the check waits for the extension to connect. */
	waitMs?: number;
}

/** Whether a linked browser (as the extension names it) is the browser chosen in the list. */
export function sameBrowser(linked: string, chosen: string): boolean {
	const a = linked.toLowerCase();
	const b = chosen.replace(/ \(Flatpak\)$/, "").toLowerCase();
	return a === b || a.includes(b) || b.includes(a);
}

/** The guided setup; resolves with the browser linked, or undefined when the user left before the end. */
export async function runBrowserSetup(ui: WizardUi, deps: WizardDeps): Promise<string | undefined> {
	const title = t("Set up your browser");
	const browsers = deps.browsers();
	if (browsers.length === 0) {
		await ui.ask({
			id: "none",
			title,
			lines: [
				t(
					"No supported browser found in your home folder (Chromium, Chrome, Brave, Vivaldi, Edge, Helium, Firefox, Zen, or one of them in Flatpak).",
				),
			],
			actions: [],
		});
		return undefined;
	}
	// kept by host process, not by name. Zen's host, linked before a
	// reload of its extension, made the name "Firefox" look known, and the new host of Zen was never taken.
	const before = new Set((await deps.linked()).map((browser) => browser.pid));
	for (;;) {
		const chosen = await ui.ask({
			id: "choose",
			title,
			lines: [
				fill("Step {0} of {1}", "1", "3"),
				t("Which browser should the agent use? It opens tabs of its own there; your tabs stay out of its reach."),
			],
			actions: browsers.map((browser, index) => ({
				id: String(index),
				label: browser.name,
				description:
					browser.family === "chromium"
						? t("Real clicks and keys.")
						: t("Clicks by script; real ones once started with /browser firefox."),
			})),
		});
		if (chosen === undefined) return undefined;
		const browser = browsers[Number(chosen)];
		if (!browser) return undefined;
		const linked = await setUp(ui, deps, browser, before);
		if (linked) return linked;
	}
}

/** Steps 2 and 3 for one browser; the linked browser's name, or undefined to choose another one. */
async function setUp(
	ui: WizardUi,
	deps: WizardDeps,
	browser: FoundBrowser,
	before: Set<number>,
): Promise<string | undefined> {
	const title = fill("Set up {0}", browser.name);
	let declared: ReturnType<WizardDeps["declare"]>;
	try {
		declared = deps.declare(browser);
	} catch (error) {
		await ui.ask({
			id: "declare-failed",
			title,
			lines: [],
			errors: [fill("Could not declare the browser host: {0}", (error as Error).message)],
			actions: [],
		});
		return undefined;
	}
	// A Flatpak browser starts the host through flatpak-spawn --host, which its sandbox refuses by default; Zen also
	// needs to keep ~/.mozilla (see flatpakExtraGrants). A Firefox one needs the extension folder only to load it from
	// there: that grant waits until the user chooses the folder over the store.
	let granted = false;
	let folderGrants = declared.flatpak?.extra.filter((arg) => arg.startsWith("--filesystem=")) ?? [];
	const otherGrants = declared.flatpak?.extra.filter((arg) => !arg.startsWith("--filesystem=")) ?? [];
	if (declared.flatpak && (!declared.flatpak.hostAccess || otherGrants.length > 0)) {
		const app = declared.flatpak.app;
		const answer = await ui.ask({
			id: "flatpak",
			title,
			lines: [
				fill("Step {0} of {1}", "2", "3"),
				...(declared.flatpak.hostAccess
					? []
					: [
							fill(
								"The Prism extension reaches Prism through flatpak-spawn --host. Prism runs: flatpak override --user --talk-name=org.freedesktop.Flatpak {0}. With it, this browser can start any program on your computer outside its sandbox, not only Prism. Undo with: flatpak override --user --no-talk-name=org.freedesktop.Flatpak {0}.",
								app,
							),
						]),
				...otherGrants.map((arg) => grantLine(arg, app)),
			],
			actions: [
				{ id: "allow", label: t("Allow and continue") },
				{ id: "other", label: t("Choose another browser") },
			],
		});
		if (answer !== "allow") return undefined;
		try {
			deps.grantFlatpak(app, otherGrants);
			granted = true;
			declared = { ...declared, flatpak: { app, hostAccess: true, extra: folderGrants } };
		} catch (error) {
			await ui.ask({
				id: "flatpak-failed",
				title,
				lines: [],
				errors: [fill("{0}: flatpak override failed: {1}", browser.name, (error as Error).message)],
				actions: [],
			});
			return undefined;
		}
	}
	let folder: string;
	try {
		folder = deps.extensionDir(browser);
	} catch (error) {
		await ui.ask({ id: "folder-failed", title, lines: [], errors: [(error as Error).message], actions: [] });
		return undefined;
	}
	const page = extensionsPage(browser.family);
	const store = extensionStorePage(browser.family);
	// The store comes first (both stores accepted the extension); the folder stays for a browser without the store
	// (Ungoogled Chromium) and for development.
	let fromFolder = false;
	let note: string | undefined;
	let problem: string | undefined;
	for (;;) {
		const answer = await ui.ask(
			fromFolder
				? {
						id: "extension-folder",
						title,
						lines: [
							fill("Step {0} of {1}", "2", "3"),
							t("Add the Prism extension:"),
							...folderSteps(browser, granted, page, folder),
							...(note ? [note] : []),
						],
						...(problem ? { errors: [problem] } : {}),
						actions: [
							{ id: "open", label: fill("Open {0}", browser.name) },
							{ id: "copy-page", label: t("Copy the address") },
							{ id: "copy", label: t("Copy the folder path") },
							{
								id: "check",
								label: t("It is added: check"),
								description: t("Opens, reads and closes a tab of its own."),
							},
							{ id: "store", label: t("Back to the store") },
						],
					}
				: {
						id: "extension",
						title,
						lines: [
							fill("Step {0} of {1}", "2", "3"),
							t("Add the Prism extension:"),
							...storeSteps(browser, granted, store),
							t("No store in this browser, or no add button? Load the extension from a folder instead."),
							...(note ? [note] : []),
						],
						...(problem ? { errors: [problem] } : {}),
						actions: [
							{ id: "open-store", label: fill("Open the page in {0}", browser.name) },
							{ id: "copy-store", label: t("Copy the address") },
							{
								id: "check",
								label: t("It is added: check"),
								description: t("Opens, reads and closes a tab of its own."),
							},
							{
								id: "folder",
								label: t("Load from a folder instead"),
								description:
									browser.family === "chromium"
										? t("Developer mode, for a browser without the store.")
										: t("A temporary add-on, removed at each restart."),
							},
						],
					},
		);
		note = undefined;
		problem = undefined;
		if (answer === undefined || answer === "store") {
			if (!fromFolder) return undefined;
			fromFolder = false;
			continue;
		}
		if (answer === "open" || answer === "open-store") {
			const failed = deps.openBrowser(browser, answer === "open-store" ? store : undefined);
			if (failed) problem = failed;
			else note = fill("{0} opened.", browser.name);
			continue;
		}
		if (answer === "copy-page" || answer === "copy-store") {
			const address = answer === "copy-store" ? store : page;
			try {
				await deps.copy(address);
				note = fill("{0} copied: paste it in the address bar of {1}.", address, browser.name);
			} catch (error) {
				problem = fill("Could not copy: {0}", (error as Error).message);
			}
			continue;
		}
		if (answer === "copy") {
			try {
				await deps.copy(folder);
				note = t("Folder path copied.");
			} catch (error) {
				problem = fill("Could not copy: {0}", (error as Error).message);
			}
			continue;
		}
		if (answer === "folder") {
			// A Flatpak Firefox reaches the folder only once allowed to: asked here, not for the store.
			if (declared.flatpak && folderGrants.length > 0) {
				const app = declared.flatpak.app;
				const consent = await ui.ask({
					id: "flatpak-folder",
					title,
					lines: [fill("Step {0} of {1}", "2", "3"), ...folderGrants.map((arg) => grantLine(arg, app))],
					actions: [
						{ id: "allow", label: t("Allow and continue") },
						{ id: "store", label: t("Back to the store") },
					],
				});
				if (consent !== "allow") continue;
				try {
					deps.grantFlatpak(app, folderGrants);
					folderGrants = [];
					granted = true;
				} catch (error) {
					problem = fill("{0}: flatpak override failed: {1}", browser.name, (error as Error).message);
					continue;
				}
			}
			fromFolder = true;
			continue;
		}
		const outcome = await check(ui, deps, browser, before, declared, fromFolder);
		if (outcome === "linked") return browser.name;
		if (outcome === "other") return undefined;
	}
}

/** The consent line of one extra `flatpak override` argument. */
function grantLine(arg: string, app: string): string {
	return arg.startsWith("--filesystem=")
		? fill(
				"Prism also runs: flatpak override --user {0} {1}. This browser can then read and write the extension folder: without write access, the file picker of a Flatpak gives it a copy of manifest.json alone, and the extension cannot load.",
				arg,
				app,
			)
		: fill(
				"Prism also runs: flatpak override --user {0} {1}. This browser then keeps its ~/.mozilla folder, where it reads the Prism host declaration.",
				arg,
				app,
			);
}

/** Zen's portal pref, when its Flatpak needs it: the first step either way. */
function portalStep(browser: FoundBrowser): string[] {
	// Zen's Flatpak sends native messaging through a portal this computer lacks (probed, Zen 1.23.3b).
	return browser.extraHostsDir
		? [
				fill(
					"In {0}, open about:config and set widget.use-xdg-desktop-portal.native-messaging to 0: without it, {0} does not read Prism's host declaration.",
					browser.name,
				),
			]
		: [];
}

const numbered = (actions: readonly string[]): string[] =>
	actions.map((text, index) => fill("{0}. {1}", String(index + 1), text));

/** The steps that install the extension from the browser family's store. */
function storeSteps(browser: FoundBrowser, granted: boolean, store: string): string[] {
	const actions = portalStep(browser);
	if (browser.extraHostsDir || granted) {
		// A store install survives a restart, unlike a temporary add-on: the order does not matter here.
		actions.push(
			fill(
				"Close {0} completely, then start it again: what was just changed applies only when it starts.",
				browser.name,
			),
		);
	}
	actions.push(
		fill(
			"Open the Prism extension's page in {1}: {0} (the buttons below open it there and copy its address).",
			store,
			browser.name,
		),
		browser.family === "chromium"
			? t("Choose Add to Chrome, then Add extension.")
			: t("Choose Add to Firefox, then Add."),
	);
	return numbered(actions);
}

/** The steps that load the extension from the folder Prism wrote: unpacked (Chromium) or temporary (Firefox). */
function folderSteps(browser: FoundBrowser, granted: boolean, page: string, folder: string): string[] {
	const actions = portalStep(browser);
	// Zen's Flatpak was told to restart after the temporary add-on was loaded, which removes it,
	// and its new Flatpak permissions (the extension folder) apply only when it starts. Restart first, then add it.
	if (browser.extraHostsDir || granted) {
		actions.push(
			fill(
				"Close {0} completely, then start it again: what was just changed applies only when it starts. Do it before adding the extension, which a restart removes.",
				browser.name,
			),
		);
	}
	// a browser given its extensions page on the command line did not always open it (Chromium
	// opens its New Tab page, Zen another page): the address is copied by its own button and pasted by the user.
	actions.push(
		fill(
			"In the address bar of {1}, paste {0} (the buttons below open {1} and copy the address).",
			page,
			browser.name,
		),
	);
	if (browser.family === "chromium") {
		actions.push(
			t("Turn on Developer mode, at the top right."),
			fill("Choose Load unpacked and select this folder: {0}", folder),
		);
	} else {
		actions.push(fill("Choose Load Temporary Add-on and select manifest.json in this folder: {0}", folder));
	}
	const steps = numbered(actions);
	if (browser.family === "firefox") {
		steps.push(
			t(
				"A temporary add-on is removed when the browser closes: add it again after a restart, or install the extension from the store.",
			),
		);
	}
	return steps;
}

/** Step 3: waits for the extension, then checks it end to end; "linked", "steps" (back to them) or "other". */
async function check(
	ui: WizardUi,
	deps: WizardDeps,
	browser: FoundBrowser,
	before: Set<number>,
	declared: ReturnType<WizardDeps["declare"]>,
	fromFolder: boolean,
): Promise<"linked" | "steps" | "other"> {
	const title = fill("Set up {0}", browser.name);
	for (;;) {
		let leave = false;
		let found: LinkedBrowser | undefined;
		let others: LinkedBrowser[] = [];
		let failure: string | undefined;
		const waited = (async () => {
			const end = Date.now() + (deps.waitMs ?? 60_000);
			while (!leave && Date.now() < end) {
				const linked = await deps.linked();
				const fresh = linked.filter((entry) => !before.has(entry.pid));
				found =
					fresh.find((entry) => sameBrowser(entry.name, browser.name)) ??
					fresh[0] ??
					linked.find((entry) => sameBrowser(entry.name, browser.name));
				others = linked.filter((entry) => entry !== found);
				if (found) {
					failure = found.stopped
						? t("The agent's control was stopped from this browser: /browser resume gives it back.")
						: await deps.check(found.pid);
					return "done";
				}
				await deps.sleep(500);
			}
			return "done";
		})();
		const answer = await ui.ask(
			{
				id: "waiting",
				title,
				lines: [
					fill("Step {0} of {1}", "3", "3"),
					fill("Waiting for the Prism extension in {0} to connect, then opening a tab to check…", browser.name),
				],
				actions: [{ id: "steps", label: t("Back to the steps") }],
			},
			waited,
		);
		leave = true;
		if (answer !== "done") return "steps";
		if (found && !failure) {
			deps.choose(found.name);
			await ui.ask({
				id: "linked",
				title: fill("{0} is linked", browser.name),
				lines: [
					fill(
						"{0} {1}: {2}.",
						found.name,
						found.version.split(".")[0] ?? "",
						found.realInput ? t("real clicks") : t("clicks by script"),
					),
					t("Checked: Prism opened, read and closed a tab of its own through the extension."),
					t("The agent uses this browser from now on."),
					...(browser.family === "firefox" && !found.realInput
						? [
								t(
									"For real clicks and keys in Firefox: /browser firefox (it restarts Firefox with remote control).",
								),
							]
						: []),
				],
				actions: [{ id: "done", label: t("Done") }],
			});
			return "linked";
		}
		// What is in place and what is not, in plain words.
		const diagnostics = [fill("Host declared for {0}: {1}", browser.name, declared.path)];
		if (declared.flatpak) {
			diagnostics.push(
				declared.flatpak.hostAccess
					? t("The browser may start Prism outside its sandbox.")
					: t("The browser may not start Prism outside its sandbox."),
			);
		}
		const errors: string[] = [];
		if (!found) {
			errors.push(fill("The extension did not connect from {0}.", browser.name));
			diagnostics.push(
				browser.family === "chromium"
					? t(
							"Is the extension in chrome://extensions, turned on, without an error? Restarting the browser after the first declaration can help.",
						)
					: fromFolder
						? t("Is the extension in about:debugging? A temporary add-on is gone after a restart of the browser.")
						: t(
								"Is the Prism extension in about:addons, turned on? Restarting the browser after the first declaration can help.",
							),
			);
			if (others.length > 0) {
				diagnostics.push(fill("Connected instead: {0}.", others.map((entry) => entry.name).join(", ")));
			}
		} else {
			errors.push(fill("The extension connected, but the check failed: {0}", failure ?? ""));
		}
		const next = await ui.ask({
			id: "diagnostics",
			title,
			lines: diagnostics,
			errors,
			actions: [
				{ id: "retry", label: t("Check again") },
				{ id: "steps", label: t("Back to the steps") },
				{ id: "other", label: t("Choose another browser") },
			],
		});
		if (next === "retry") continue;
		return next === "other" ? "other" : "steps";
	}
}

/** The setup's screens in the Prism window. */
export class NativeBrowserSetupView extends NativeFlow implements WizardUi {
	constructor(changed: () => void) {
		super(changed, { screenId: "loading", kind: "detail", title: t("Set up your browser"), busy: true });
	}

	ask(screen: WizardScreen, until?: Promise<string>): Promise<string | undefined> {
		const prefix = this.nextPrefix();
		return this.wait<string>((finish) => {
			let open = true;
			void until?.then((value) => {
				if (open) finish(value);
			});
			this.show(
				{
					screenId: screen.id,
					kind: "actions",
					title: screen.title,
					lines: screen.lines,
					...(screen.errors ? { errors: screen.errors } : {}),
					items: screen.actions.map((action) => ({
						id: prefix + action.id,
						label: action.label,
						...(action.description ? { description: action.description } : {}),
					})),
					hint: screen.actions.length === 0 ? "close" : "back",
				},
				(action) => {
					if (action.kind === "back") {
						finish(undefined);
						return true;
					}
					const id = this.itemOf(action, prefix);
					if (action.kind !== "activate" || id === undefined) return false;
					finish(id);
					return true;
				},
			);
			return () => {
				open = false;
			};
		});
	}
}

/** The setup's screens as the terminal's dialogs. */
export function dialogUi(ctx: ExtensionContext): WizardUi {
	return {
		async ask(screen, until) {
			const controller = new AbortController();
			let settled: string | undefined;
			void until?.then((value) => {
				settled = value;
				controller.abort();
			});
			const text = [screen.title, ...screen.lines, ...(screen.errors ?? []).map((error) => `! ${error}`)].join("\n");
			if (screen.actions.length === 0) {
				ctx.ui.notify(text, screen.errors?.length ? "error" : "info");
				return undefined;
			}
			const labels = screen.actions.map((action) => action.label);
			const picked = await ctx.ui.select(text, labels, { signal: controller.signal });
			if (settled !== undefined) return settled;
			controller.abort();
			return screen.actions.find((action) => action.label === picked)?.id;
		},
	};
}

/** Runs the setup in the window's native screens. */
export async function runNativeBrowserSetup(ctx: ExtensionContext, deps: WizardDeps): Promise<string | undefined> {
	let linked: string | undefined;
	await showNativeFlow<NativeBrowserSetupView>(
		ctx,
		(changed) => new NativeBrowserSetupView(changed),
		async (view) => {
			linked = await runBrowserSetup(view, deps);
		},
	);
	return linked;
}
