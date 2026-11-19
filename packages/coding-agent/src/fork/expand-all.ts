/**
 * fork: Ctrl+O opens or closes every block, whatever was clicked open or closed before
 *. Upstream skipped components already at the global state, so a block toggled by a click
 * kept its own state and Ctrl+O looked like a partial inversion.
 */
export interface Expandable {
	setExpanded(expanded: boolean): void;
}

export function isExpandable(component: unknown): component is Expandable {
	return (
		typeof component === "object" &&
		component !== null &&
		"setExpanded" in component &&
		typeof component.setExpanded === "function"
	);
}

/** Reapply even an unchanged global state to discard individual click overrides. */
export function applyExpansion(expanded: boolean, components: readonly unknown[]): void {
	for (const component of components) {
		if (isExpandable(component)) component.setExpanded(expanded);
	}
}
