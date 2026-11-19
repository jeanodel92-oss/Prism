// `/export-zip` as native screens in the Prism window: the sessions, then the files, as checkbox
// lists, then the archive's summary and its confirmation, in one panel. The command keeps every check (no session,
// size limit), the files offered and refused, the archive's contents and its writing; this only shows its screens.
import type { ExtensionContext } from "../core/extensions/types.ts";
import { t } from "./i18n/index.ts";
import { NativeFlow, showNativeFlow } from "./native-flow.ts";

/** A session or a file to check. */
export interface ExportChoice {
	id: string;
	label: string;
	description?: string;
	checked: boolean;
}

/** The confirmation's text, and what the command needs to write the archive it describes. */
export interface ExportReview<T> {
	lines: string[];
	items: string[];
	warning: string;
	/** The archive's path, shown when changing it. */
	destination: string;
	data: T;
}

export interface ExportSteps<T> {
	sessions: ExportChoice[];
	/** What is wrong with the chosen sessions (none, too large), or the files to offer for them. */
	files(sessionIds: string[]): { problem: string } | { files: ExportChoice[] };
	review(sessionIds: string[], fileIds: string[]): ExportReview<T>;
	/** the archive's new destination, as typed; what is wrong with it, or undefined once changed. */
	destination(typed: string): string | undefined;
}

const markdown = (text: string) => text.replace(/[\\`*_[\]<>#|]/g, "\\$&");

export class NativeExportView<T> extends NativeFlow {
	private readonly steps: ExportSteps<T>;

	constructor(changed: () => void, steps: ExportSteps<T>) {
		super(changed, { screenId: "loading", kind: "detail", title: t("Portable export"), busy: true });
		this.steps = steps;
	}

	/** Until the archive is confirmed or the panel closed. */
	run(): Promise<T | undefined> {
		return this.wait<T>((finish) => {
			const sessions = new Set(this.steps.sessions.filter((choice) => choice.checked).map((choice) => choice.id));
			const files = new Set<string>();
			let offered: ExportChoice[] = [];
			/** One checkbox list; `next` moves on, and returns a problem to show here instead. */
			const checklist = (
				screenId: string,
				title: string,
				choices: ExportChoice[],
				checked: Set<string>,
				back: () => void,
				next: () => string | undefined,
				problem?: string,
			) => {
				const prefix = this.nextPrefix();
				const render = (error?: string) =>
					this.show(
						{
							screenId,
							kind: "multiSelect",
							title,
							hint: screenId === "sessions" ? "close" : "back",
							...(error ? { errors: [error] } : {}),
							items: choices.map((choice) => ({
								id: prefix + choice.id,
								label: choice.label,
								description: choice.description,
								selected: checked.has(choice.id),
							})),
							actions: [{ id: `${prefix}continue`, label: t("Continue") }],
						},
						(action) => {
							if (action.kind === "back") {
								back();
								return true;
							}
							if (action.kind === "activate" && action.itemId === `${prefix}continue`) {
								const error = next();
								if (error) render(error);
								return true;
							}
							const choice = choices.find((candidate) => prefix + candidate.id === action.itemId);
							if (action.kind !== "multiSelect" || !choice || typeof action.selected !== "boolean") return false;
							if (action.selected) checked.add(choice.id);
							else checked.delete(choice.id);
							render();
							return true;
						},
					);
				render(problem);
			};
			// In the order of the lists, as the terminal returns them.
			const chosen = (choices: ExportChoice[], checked: Set<string>) =>
				choices.filter((choice) => checked.has(choice.id)).map((choice) => choice.id);
			const review = (back: () => void) => {
				const prefix = this.nextPrefix();
				const summary = this.steps.review(chosen(this.steps.sessions, sessions), chosen(offered, files));
				this.show(
					{
						screenId: "review",
						kind: "review",
						title: t("Portable export"),
						lines: summary.lines,
						content: [...summary.items.map((item) => `- ${markdown(item)}`), "", markdown(summary.warning)].join(
							"\n",
						),
						format: { kind: "markdown" },
						confirm: { id: `${prefix}create`, label: t("Create the archive") },
						actions: [{ id: `${prefix}destination`, label: t("Change the destination") }],
						hint: "back",
					},
					(action) => {
						if (action.kind === "back") {
							back();
							return true;
						}
						if (action.kind !== "activate") return false;
						if (action.itemId === `${prefix}destination`) {
							chooseDestination(summary.destination, () => review(back));
							return true;
						}
						if (action.itemId !== `${prefix}create`) return false;
						finish(summary.data);
						return true;
					},
				);
			};
			/** The archive's path, as a field; Back keeps the one shown. */
			const chooseDestination = (current: string, back: () => void) => {
				const render = (value: string, error?: string) =>
					this.show(
						{
							screenId: "destination",
							kind: "input",
							title: t("Archive destination (a file or a folder)"),
							value,
							hint: "back",
							...(error ? { errors: [error] } : {}),
						},
						(action) => {
							if (action.kind === "back") {
								back();
								return true;
							}
							if (action.kind !== "input" || typeof action.value !== "string") return false;
							const problem = this.steps.destination(action.value);
							if (problem) render(action.value, problem);
							else back();
							return true;
						},
					);
				render(current);
			};
			const chooseFiles = () =>
				checklist("files", t("Files to include (none by default)"), offered, files, chooseSessions, () => {
					review(chooseFiles);
					return undefined;
				});
			const chooseSessions = (problem?: string) =>
				checklist(
					"sessions",
					t("Sessions to export"),
					this.steps.sessions,
					sessions,
					() => finish(undefined),
					() => {
						const next = this.steps.files(chosen(this.steps.sessions, sessions));
						if ("problem" in next) return next.problem;
						// Files offered again keep their marks; others are dropped.
						const ids = new Set(next.files.map((file) => file.id));
						for (const id of files) if (!ids.has(id)) files.delete(id);
						offered = next.files;
						if (offered.length > 0) chooseFiles();
						else review(() => chooseSessions());
						return undefined;
					},
					problem,
				);
			chooseSessions();
			return () => {};
		});
	}
}

/** `/export-zip`'s choices, asked in the window: the data of the review confirmed, or undefined. */
export async function chooseExportNative<T>(ctx: ExtensionContext, steps: ExportSteps<T>): Promise<T | undefined> {
	let result: T | undefined;
	await showNativeFlow<NativeExportView<T>>(
		ctx,
		(changed) => new NativeExportView(changed, steps),
		async (view) => {
			result = await view.run();
		},
	);
	return result;
}
