import type { AuthInfoLink, OAuthDeviceCodeInfo } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	getKeybindings,
	hyperlink,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { fill, t } from "../../../fork/i18n/index.ts";
import { openBrowser } from "../../../utils/open-browser.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

/** fork: drawn in place of each character of a secret. */
export const SECRET_MASK = "•";

/**
 * Login dialog component - replaces editor during OAuth login flow
 */
export class LoginDialogComponent extends Container implements Focusable {
	private contentContainer: Container;
	private input: Input;
	private tui: TUI;
	private abortController = new AbortController();
	private inputResolver?: (value: string) => void;
	private inputRejecter?: (error: Error) => void;
	private onComplete: (success: boolean, message?: string) => void;

	// Focusable implementation - propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		providerId: string,
		onComplete: (success: boolean, message?: string) => void,
		providerNameOverride?: string,
		titleOverride?: string,
	) {
		super();
		this.tui = tui;
		this.onComplete = onComplete;

		const providerName = providerNameOverride || providerId;
		const title = titleOverride ?? `Login to ${providerName}`;

		// Top border
		this.addChild(new DynamicBorder());

		// Title
		this.addChild(new Text(theme.fg("accent", theme.bold(t(title))), 1, 0));

		// Dynamic content area
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// Input (always present, used when needed)
		this.input = this.newInput();

		// Bottom border
		this.addChild(new DynamicBorder());
	}

	/**
	 * fork: one field per step, so a secret left in the undo stack or the kill
	 * ring of one step cannot come back in the next.
	 */
	private newInput(mask?: string): Input {
		const input = new Input({ mask });
		input.focused = this._focused;
		input.onSubmit = () => {
			if (this.inputResolver) {
				const value = input.getValue();
				this.replaceInputWithSubmittedText(value);
				this.inputResolver(value);
				this.inputResolver = undefined;
				this.inputRejecter = undefined;
			}
		};
		input.onEscape = () => {
			this.cancel();
		};
		return input;
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	private replaceInputWithSubmittedText(value: string): void {
		// fork: a secret stays masked once submitted.
		const shown = this.input.mask === undefined ? value : this.input.mask.repeat(Array.from(value).length);
		this.contentContainer.children = this.contentContainer.children.map((child) =>
			child === this.input ? new Text(`> ${shown}`, 0, 0) : child,
		);
	}

	private cancel(): void {
		this.abortController.abort();
		if (this.inputRejecter) {
			this.inputRejecter(new Error("Login cancelled"));
			this.inputResolver = undefined;
			this.inputRejecter = undefined;
		}
		this.onComplete(false, "Login cancelled");
	}

	/**
	 * Called by onAuth callback - show URL and optional instructions
	 */
	showAuth(url: string, instructions?: string): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		// fork: hyperlink() marks the link as Prism's own, so Text keeps it.
		const linkedUrl = hyperlink(url, url);
		this.contentContainer.addChild(new Text(theme.fg("accent", linkedUrl), 1, 0));

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		const hintLink = hyperlink(t(clickHint), url);
		this.contentContainer.addChild(new Text(theme.fg("dim", hintLink), 1, 0));

		if (instructions) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("warning", t(instructions)), 1, 0));
		}

		openBrowser(url);
		this.tui.requestRender();
	}

	/**
	 * Called by onDeviceCode callback - show URL and user code.
	 */
	showDeviceCode(info: OAuthDeviceCodeInfo): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		const linkedUrl = hyperlink(info.verificationUri, info.verificationUri);
		this.contentContainer.addChild(new Text(theme.fg("accent", linkedUrl), 1, 0));

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		const hintLink = hyperlink(t(clickHint), info.verificationUri);
		this.contentContainer.addChild(new Text(theme.fg("dim", hintLink), 1, 0));
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(
			new Text(theme.fg("warning", fill("On the web page above, enter this code: {0}", info.userCode)), 1, 0),
		);

		this.tui.requestRender();
	}

	/**
	 * Show input for manual code/URL entry (for callback server providers)
	 */
	showManualInput(prompt: string): Promise<string> {
		this.input = this.newInput();
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", t(prompt)), 1, 0));
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/**
	 * Called by onPrompt callback - show prompt and wait for input
	 * Note: Does NOT clear content, appends to existing (preserves URL from showAuth)
	 */
	showPrompt(message: string, placeholder?: string, secret = false): Promise<string> {
		// fork: mask secrets such as API keys while they are typed or pasted.
		this.input = this.newInput(secret ? SECRET_MASK : undefined);
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", t(message)), 1, 0));
		if (placeholder) {
			this.contentContainer.addChild(new Text(theme.fg("dim", fill("e.g., {0}", placeholder)), 1, 0));
		}
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(
			new Text(
				`(${keyHint("tui.select.cancel", "to cancel,")} ${keyHint("tui.select.confirm", "to submit")})`,
				1,
				0,
			),
		);

		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/** Show informational text before another login step. */
	showDetails(lines: string[]): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		for (const line of lines) {
			this.contentContainer.addChild(new Text(t(line), 1, 0));
		}
		this.tui.requestRender();
	}

	/** Show provider-owned information and links without starting an auth callback flow. */
	showInfo(message: string, links: readonly AuthInfoLink[] = [], showCloseHint = false): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", t(message)), 1, 0));
		for (const link of links) {
			const text = link.label ? `${link.label}: ${link.url}` : link.url;
			this.contentContainer.addChild(new Text(theme.fg("accent", hyperlink(text, link.url)), 1, 0));
		}
		if (showCloseHint) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to close")})`, 1, 0));
		}
		this.tui.requestRender();
	}

	/**
	 * Show waiting message (for polling flows like GitHub Copilot)
	 */
	showWaiting(message: string): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", t(message)), 1, 0));
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();
	}

	/**
	 * Called by onProgress callback
	 */
	showProgress(message: string): void {
		this.contentContainer.addChild(new Text(theme.fg("dim", t(message)), 1, 0));
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}

		// Pass to input
		this.input.handleInput(data);
	}
}
