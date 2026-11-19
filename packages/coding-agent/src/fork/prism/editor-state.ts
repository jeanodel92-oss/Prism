// fork: the private upstream fields Prism's composer needs.
import type { StatusIndicatorKind } from "../../modes/interactive/components/status-indicator.ts";

export interface EditorState {
	renderedVisibleLineCount: number;
	scrollOffset: number;
	workingStatusIndicator:
		| {
				kind: StatusIndicatorKind;
				message: string;
				renderInBorder(width: number): string;
		  }
		| undefined;
}

/** Fail at the boundary when upstream renames a field, instead of silently drawing invalid rows. */
export function editorState(editor: object): EditorState {
	const state = editor as Partial<Record<keyof EditorState, unknown>>;
	for (const key of ["renderedVisibleLineCount", "scrollOffset"] as const) {
		if (typeof state[key] !== "number" || !Number.isFinite(state[key]))
			throw new Error(`Prism editor: upstream field ${key} is missing or invalid`);
	}
	if (!("workingStatusIndicator" in state))
		throw new Error("Prism editor: upstream field workingStatusIndicator is missing");
	const indicator = state.workingStatusIndicator as
		| Partial<NonNullable<EditorState["workingStatusIndicator"]>>
		| undefined;
	if (
		indicator !== undefined &&
		(indicator === null ||
			!["working", "retry", "compaction", "branchSummary"].includes(indicator.kind ?? "") ||
			typeof indicator.message !== "string" ||
			typeof indicator.renderInBorder !== "function")
	)
		throw new Error("Prism editor: upstream field workingStatusIndicator is invalid");
	return editor as unknown as EditorState;
}
