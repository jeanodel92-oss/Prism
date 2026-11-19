// the task scope's approval as a native screen of the Prism window, for `/perm` › « Set a task
// scope… » and for the agent's `propose_scope`. The same choices as ScopeView: each line kept or left out, the
// duration and the presence changed, Approve or Cancel. The caller keeps starting the scope.
import type { ExtensionContext } from "../core/extensions/types.ts";
import { fill, t } from "./i18n/index.ts";
import { NativeFlow, showNativeFlow } from "./native-flow.ts";
import { operationDetail, type ScopeApproval, type ScopeProposal, scopeDurations, scopeLimits } from "./task-scope.ts";

export class NativeScopeView extends NativeFlow {
	private readonly proposal: ScopeProposal;
	private readonly readLimited: boolean;
	private readonly maxMinutes: number;

	constructor(changed: () => void, proposal: ScopeProposal, readLimited: boolean, maxMinutes: number) {
		super(changed, { screenId: "loading", kind: "detail", title: t("Set a task scope"), busy: true });
		this.proposal = proposal;
		this.readLimited = readLimited;
		this.maxMinutes = maxMinutes;
	}

	/** The approved scope, or undefined when it is cancelled or the panel closed. */
	run(): Promise<ScopeApproval | undefined> {
		return this.wait<ScopeApproval>((finish) => {
			const { operations } = this.proposal;
			const kept = operations.map(() => true);
			const { durations, index } = scopeDurations(this.proposal.minutes, this.maxMinutes);
			let duration = index;
			let away = false;
			const prefix = this.nextPrefix();
			const render = () => {
				const none = kept.every((keep) => !keep);
				this.show(
					{
						screenId: "scope",
						kind: "multiSelect",
						title: this.proposal.from === "agent" ? t("Task scope proposed by the agent") : t("Set a task scope"),
						lines: [
							t("Within it, the agent works without asking. Untick a line to leave it out."),
							away
								? t("Anything else is refused at once; you get the list when the task ends.")
								: t("Anything else is asked about, as now."),
							...scopeLimits(this.readLimited).map((line) => t(line)),
						],
						hint: "close",
						items: operations.map((operation, row) => ({
							id: `${prefix}op:${row}`,
							label: operation.what,
							description: operationDetail(operation),
							selected: kept[row],
						})),
						actions: [
							{ id: `${prefix}duration`, label: fill("Duration: {0} min", String(durations[duration] ?? 60)) },
							{
								id: `${prefix}presence`,
								label: away ? t("While it runs: I'm away") : t("While it runs: I stay here"),
							},
							{ id: `${prefix}approve`, label: t("Approve"), disabled: none },
							{ id: `${prefix}cancel`, label: t("Cancel") },
						],
					},
					(action) => {
						if (action.kind === "back") {
							finish(undefined);
							return true;
						}
						const id = String(action.itemId ?? "");
						if (!id.startsWith(prefix)) return false;
						const target = id.slice(prefix.length);
						if (action.kind === "multiSelect" && target.startsWith("op:")) {
							const row = Number(target.slice(3));
							if (!(row in kept)) return false;
							kept[row] = action.selected === true;
						} else if (action.kind !== "activate") return false;
						else if (target === "duration") duration = (duration + 1) % durations.length;
						else if (target === "presence") away = !away;
						else if (target === "cancel") {
							finish(undefined);
							return true;
						} else if (target === "approve") {
							const chosen = operations.filter((_, row) => kept[row]);
							if (chosen.length === 0) return false;
							finish({ operations: chosen, minutes: durations[duration] ?? 60, away });
							return true;
						} else return false;
						render();
						return true;
					},
				);
			};
			render();
			return () => {};
		});
	}
}

/** The scope's approval, asked in the window. */
export async function approveScopeNative(
	ctx: ExtensionContext,
	proposal: ScopeProposal,
	readLimited: boolean,
	maxMinutes: number,
): Promise<ScopeApproval | undefined> {
	let result: ScopeApproval | undefined;
	await showNativeFlow<NativeScopeView>(
		ctx,
		(changed) => new NativeScopeView(changed, proposal, readLimited, maxMinutes),
		async (view) => {
			result = await view.run();
		},
	);
	return result;
}
