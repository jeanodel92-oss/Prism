// `/init` as native screens in the Prism window: the starting point, the plan when one is pasted,
// then the documents it will create or adapt and the confirmation, in one panel. The command keeps resolving the
// plan, building the review and starting the turn; this only shows its screens and returns the answers.
import type { ExtensionContext } from "../core/extensions/types.ts";
import { t } from "./i18n/index.ts";
import { NativeFlow, showNativeFlow } from "./native-flow.ts";

/**
 * One starting point, in the terminal's order; `asksPlan` for "From a plan", which asks for the plan first;
 * `direct` for one chosen without the confirmation, as it writes nothing (planning first in plan mode).
 */
export interface InitStartOption {
	id: string;
	label: string;
	asksPlan?: boolean;
	direct?: boolean;
}

/** What the confirmation shows, built by the command for a starting point. */
export interface InitReview {
	/** Project and starting point. */
	lines: string[];
	/** Every continuity document, created or adapted. */
	files: Array<{ path: string; exists: boolean }>;
	/** What follows the documents: files reused rather than copied, and how the model writes them. */
	notes: string[];
}

/** The starting point chosen and confirmed, its pasted plan, or "declined" when the confirmation was refused. */
export type InitAnswer = { id: string; plan?: string } | "declined" | undefined;

const cell = (text: string) => text.replaceAll("|", "\\|");

export class NativeInitView extends NativeFlow {
	private readonly options: InitStartOption[] | undefined;
	/** On the confirmation: closing the panel there refuses, as No does in the terminal. */
	reviewing = false;
	private readonly review: (id: string, plan?: string) => InitReview;

	constructor(
		changed: () => void,
		options: InitStartOption[] | undefined,
		review: (id: string, plan?: string) => InitReview,
	) {
		super(changed, { screenId: "loading", kind: "detail", title: t("Start from"), busy: true });
		this.options = options;
		this.review = review;
	}

	/** Without options (`/init <plan>`), only the confirmation. */
	run(fixed?: string): Promise<InitAnswer> {
		return this.wait<InitAnswer>((finish) => {
			let plan = "";
			const confirm = (option: InitStartOption, back: (() => void) | undefined) => {
				this.reviewing = true;
				const prefix = this.nextPrefix();
				const review = this.review(option.id, option.asksPlan ? plan : undefined);
				const table = [
					`| | ${t("File")} |`,
					"|---|---|",
					...review.files.map((file) => `| ${t(file.exists ? "adapt" : "create")} | \`${cell(file.path)}\` |`),
				];
				this.show(
					{
						screenId: "review",
						kind: "review",
						title: t("Set up project continuity?"),
						lines: review.lines,
						content: [...table, ...review.notes.flatMap((note) => ["", note])].join("\n"),
						format: { kind: "markdown" },
						confirm: { id: `${prefix}confirm`, label: t("Set up") },
						hint: "back",
					},
					(action) => {
						if (action.kind === "back") {
							// The first screen when /init named its plan: Back refuses, as No does in the terminal.
							if (back) back();
							else finish("declined");
							return true;
						}
						if (action.kind !== "activate" || action.itemId !== `${prefix}confirm`) return false;
						finish({ id: option.id, ...(option.asksPlan ? { plan } : {}) });
						return true;
					},
				);
			};
			const askPlan = (option: InitStartOption) => {
				this.reviewing = false;
				this.nextPrefix();
				this.show(
					{
						screenId: "plan",
						kind: "input",
						title: t("Paste the plan, or the path of a plan file"),
						multiline: true,
						value: plan,
						hint: "back",
					},
					(action) => {
						if (action.kind === "back") {
							choose();
							return true;
						}
						if (action.kind !== "input" || typeof action.value !== "string") return false;
						plan = action.value.trim();
						// An empty plan ends /init, as an empty editor does in the terminal.
						if (!plan) finish(undefined);
						else confirm(option, () => askPlan(option));
						return true;
					},
				);
			};
			const choose = () => {
				this.reviewing = false;
				const options = this.options ?? [];
				const prefix = this.nextPrefix();
				this.show(
					{
						screenId: "start",
						kind: "choice",
						title: t("Start from"),
						hint: "close",
						items: options.map((option) => ({ id: prefix + option.id, label: option.label })),
					},
					(action) => {
						if (action.kind === "back") {
							finish(undefined);
							return true;
						}
						const option = options.find((candidate) => prefix + candidate.id === action.itemId);
						if (action.kind !== "activate" || !option) return false;
						if (option.direct) finish({ id: option.id });
						else if (option.asksPlan) askPlan(option);
						else confirm(option, choose);
						return true;
					},
				);
			};
			if (fixed !== undefined) confirm({ id: fixed, label: "" }, undefined);
			else choose();
			return () => {};
		});
	}
}

/**
 * `/init`'s starting point and confirmation, asked in the window. Without `options` (`/init <plan>`), only the
 * confirmation of `fixed`.
 */
export async function chooseInitNative(
	ctx: ExtensionContext,
	options: InitStartOption[] | undefined,
	review: (id: string, plan?: string) => InitReview,
	fixed?: string,
): Promise<InitAnswer> {
	let view: NativeInitView | undefined;
	let answer: InitAnswer;
	await showNativeFlow<NativeInitView>(
		ctx,
		(changed) => {
			view = new NativeInitView(changed, options, review);
			return view;
		},
		async (flow) => {
			answer = await flow.run(fixed);
		},
	);
	return answer ?? (view?.reviewing ? "declined" : undefined);
}
