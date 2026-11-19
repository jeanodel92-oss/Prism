import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { fill, t } from "../../../fork/i18n/index.ts"; // fork
import { OUTPUT_LIMIT_STOP } from "../../../fork/model-settings.ts"; // fork
import {
	type AssistantBlock,
	type AssistantMessageRender,
	HookRenderCache,
	renderHooks,
} from "../../../fork/render-hooks.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	/** fork: thinking regions and whether each shows the hidden-thinking label. */
	private thinkingRegions = new WeakMap<MouseRegion, boolean>();
	private hookCache = new HookRenderCache<AssistantMessageRender | undefined>(); // fork

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.hookCache.clear(); // fork
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	// fork: the global expansion command also resets thinking click overrides.
	setExpanded(expanded: boolean): void {
		this.setHideThinkingBlock(!expanded);
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	/** fork: true for a message with nothing to draw, such as a turn with only tool calls. */
	drawsNothing(): boolean {
		return this.contentContainer.children.length === 0;
	}

	override render(width: number): string[] {
		const lines = this.renderHooked(width) ?? super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	// fork: render hook for the Prism pack, which draws the blocks with its own gutter.
	private renderHooked(width: number): string[] | undefined {
		const hook = renderHooks.assistantMessage;
		if (!hook) return undefined;
		// a finished message is decorated once, not on every frame.
		const rendered = this.hookCache.get(width, !this.isStreaming, () => {
			const blocks = this.contentContainer.children.map((component): AssistantBlock => {
				if (component instanceof Spacer) return { component, kind: "spacer" };
				if (component instanceof MouseRegion) {
					return { component, kind: this.thinkingRegions.get(component) ? "thinking-hidden" : "thinking" };
				}
				return { component, kind: component instanceof Text ? "notice" : "text" };
			});
			return hook(width, blocks, this.isStreaming);
		});
		if (!rendered) return undefined;
		this.contentContainer.setMouseLayout({ width, children: rendered.layout });
		this.setMouseLayout({ width, children: [{ component: this.contentContainer, height: rendered.lines.length }] });
		// render() marks the first and last lines: never on the cached array.
		const lines = [...rendered.lines];
		// fork: a thinking block shown or hidden by a click unfolds or folds.
		return renderHooks.unfolding?.(this, "thinking", lines) ?? lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		this.hookCache.clear(); // fork
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(
					new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
						transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
					}),
				);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				const runIndex = thinkingRunIndex++;
				const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
				const thinkingComponent = hidden
					? new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0)
					: new Markdown(
							thinkingBlocks.join("\n\n"),
							this.outputPad,
							0,
							this.markdownTheme,
							{
								color: (text: string) => theme.fg("thinkingText", text),
								italic: true,
							},
							{
								transform: createMarkdownTransform(
									"assistant-thinking",
									this.isStreaming,
									this.markdownTransformers,
								),
							},
						);
				const thinkingRegion = new MouseRegion(thinkingComponent, (event) => {
					if (event.type !== "click" || event.button !== "left") return undefined;
					this.thinkingVisibilityOverrides.set(runIndex, !hidden);
					renderHooks.unfold?.(this, "thinking"); // fork
					if (this.lastMessage) this.updateContent(this.lastMessage);
					return { handled: true };
				});
				this.thinkingRegions.set(thinkingRegion, hidden); // fork
				this.contentContainer.addChild(thinkingRegion);
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				// fork: say which limit stopped it and where to raise it.
				new Text(theme.fg("error", t(OUTPUT_LIMIT_STOP)), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(
					new Text(
						theme.fg("error", abortMessage === "Operation aborted" ? t("Operation aborted") : abortMessage),
						this.outputPad,
						0,
					),
				);
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || t("Unknown error");
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(
					new Text(theme.fg("error", fill("Error: {0}", errorMsg)), this.outputPad, 0),
				);
			}
		}
	}
}
