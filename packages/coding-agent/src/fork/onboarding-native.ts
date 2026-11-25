// `/onboarding` as native screens in the Prism window, one per step of `buildSteps`. Like the
// terminal's OnboardingWizard, this only collects the answers: the command writes them, applies the permission
// mode, the modules and the tutorial, and reloads.
import type { ExtensionContext } from "../core/extensions/types.ts";
import { fill, resolveLanguage, setLanguage, t } from "./i18n/index.ts";
import { NativeFlow, showNativeFlow } from "./native-flow.ts";
import { type Answers, CONTINUE, type Step, shownOptions } from "./onboarding.ts";

export class NativeOnboardingView extends NativeFlow {
	private readonly steps: Step[];
	readonly answers: Answers;
	skipped = true;

	constructor(changed: () => void, steps: Step[], initial: Answers) {
		super(changed, { screenId: "loading", kind: "detail", title: t("Welcome to Prism"), busy: true });
		this.steps = steps;
		this.answers = { ...initial };
	}

	/** Every step in turn; Back returns to the previous one. Closing the panel skips the rest, as Esc does there. */
	run(): Promise<void> {
		return this.wait<void>((finish) => {
			const enter = (index: number) => {
				const step = this.steps[index]!;
				const prefix = this.nextPrefix();
				const next = () => {
					if (index === this.steps.length - 1) {
						this.skipped = false;
						finish(undefined);
					} else enter(index + 1);
				};
				const back = () => {
					// Back from the first step leaves, as closing does.
					if (index === 0) finish(undefined);
					else enter(index - 1);
				};
				const screen = {
					screenId: `step:${step.id}`,
					title: t(step.title),
					lines: [
						`${t("Welcome to Prism")} · ${fill("Step {0} of {1}", String(index + 1), String(this.steps.length))}`,
						t(step.help),
					],
					hint: index === 0 ? "close" : "back",
				};
				if (step.toggles) {
					const render = () => {
						const selected = new Set((this.answers[step.id] as string[] | undefined) ?? []);
						this.show(
							{
								...screen,
								kind: "multiSelect",
								items: shownOptions(step, this.answers)
									.filter((option) => option.value !== CONTINUE)
									.map((option) => ({
										id: prefix + option.value,
										label: t(option.label),
										description: [option.detail, option.note]
											.filter(Boolean)
											.map((text) => t(text!))
											.join(" · "),
										selected: selected.has(option.value),
									})),
								actions: [{ id: prefix + CONTINUE, label: t("Continue") }],
							},
							(action) => {
								if (action.kind === "back") {
									back();
									return true;
								}
								if (action.kind === "activate" && action.itemId === prefix + CONTINUE) {
									next();
									return true;
								}
								const option = shownOptions(step, this.answers).find(
									(candidate) => candidate.value !== CONTINUE && prefix + candidate.value === action.itemId,
								);
								if (action.kind !== "multiSelect" || !option || typeof action.selected !== "boolean")
									return false;
								if (action.selected) selected.add(option.value);
								else selected.delete(option.value);
								// In the order of the steps, as the terminal keeps them.
								this.answers[step.id] = step.options
									.map((candidate) => candidate.value)
									.filter((value) => selected.has(value));
								render();
								return true;
							},
						);
					};
					render();
					return;
				}
				const answer = this.answers[step.id];
				const current = typeof answer === "string" ? prefix + answer : undefined;
				this.show(
					{
						...screen,
						kind: "choice",
						items: step.options.map((option) => ({
							id: prefix + option.value,
							label: t(option.label),
							description: option.detail ? t(option.detail) : undefined,
							// What to know before choosing it (Unrestricted): shown with the option, not hidden behind it.
							...(option.note ? { details: [t(option.note)] } : {}),
						})),
						...(current ? { currentItemId: current, initialItemId: current } : {}),
					},
					(action) => {
						if (action.kind === "back") {
							back();
							return true;
						}
						const option = step.options.find((candidate) => prefix + candidate.value === action.itemId);
						if (action.kind !== "activate" || !option) return false;
						this.answers[step.id] = option.value;
						// The terminal previews the language as one moves; here the next steps are worded in it.
						if (step.id === "language") setLanguage(resolveLanguage(option.value));
						next();
						return true;
					},
				);
			};
			enter(0);
			return () => {};
		});
	}
}

/** The onboarding's answers, chosen in the window; `skipped` when the panel was closed before the last step. */
export async function chooseOnboardingAnswers(
	ctx: ExtensionContext,
	steps: Step[],
	initial: Answers,
): Promise<{ answers: Answers; skipped: boolean }> {
	let view: NativeOnboardingView | undefined;
	await showNativeFlow<NativeOnboardingView>(
		ctx,
		(changed) => {
			view = new NativeOnboardingView(changed, steps, initial);
			return view;
		},
		(flow) => flow.run(),
	);
	return view ? { answers: view.answers, skipped: view.skipped } : { answers: initial, skipped: true };
}
