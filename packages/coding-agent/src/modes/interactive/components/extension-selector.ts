/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import {
	Container,
	getKeybindings,
	MouseRegion,
	Spacer,
	Text,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { t } from "../../../fork/i18n/index.ts";
import { OptionLine } from "../../../fork/option-line.ts";
import { PathText } from "../../../fork/path-text.ts";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
	description?: string;
	/** fork: a risk the answer accepts, in red under the title. */
	warning?: string;
}

export class ExtensionSelectorComponent extends Container {
	private options: string[];
	private selectedIndex = 0;
	private listContainer: Container;
	// fork: the index too, for options that share a label.
	private onSelectCallback: (option: string, index: number) => void;
	private onCancelCallback: () => void;
	private titleText: PathText;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private onToggleToolsExpanded: (() => void) | undefined;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string, index: number) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();
		title = title.split("\n").map(t).join("\n");

		this.options = options;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;
		this.baseTitle = title;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// fork: a long path breaks after a "/".
		this.titleText = new PathText(title, (text) => theme.fg("accent", theme.bold(text)), 1);
		this.addChild(this.titleText);
		if (opts?.warning) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("error", theme.bold(opts.warning.split("\n").map(t).join("\n"))), 1, 0));
		}
		if (opts?.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("text", opts.description.split("\n").map(t).join("\n")), 1, 0));
		}
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setPlain(`${this.baseTitle} (${s}s)`),
				() => this.onCancelCallback(),
			);
		}

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.options.length; i++) {
			const isSelected = i === this.selectedIndex;
			// fork: long options wrap under their text (src/fork/option-line.ts).
			const line = isSelected
				? new OptionLine(theme.fg("accent", "→ "), theme.fg("accent", t(this.options[i])))
				: new OptionLine("  ", theme.fg("text", t(this.options[i])));
			// fork: a click picks the option, as Enter does (SelectList's behaviour).
			this.listContainer.addChild(new MouseRegion(line, (event) => this.clickOption(i, event)));
		}
	}

	private clickOption(index: number, event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left") return undefined;
		if (event.type === "press") return { handled: true };
		if (event.type !== "click") return undefined;
		this.selectedIndex = index;
		this.updateList();
		const selected = this.options[index];
		if (selected) this.onSelectCallback(selected, index);
		return { handled: true };
	}

	/** fork: the wheel moves the selection one option per notch. */
	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.type !== "wheel" || !event.wheelDelta) return super.handleMouse(event);
		this.selectedIndex = Math.max(
			0,
			Math.min(this.options.length - 1, this.selectedIndex + Math.sign(event.wheelDelta)),
		);
		this.updateList();
		return {
			handled: true,
			target: {
				component: this,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y,
				width: event.width,
				height: event.height,
			},
		};
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelectCallback(selected, this.selectedIndex);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
