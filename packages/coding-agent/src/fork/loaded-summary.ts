// fork: the startup listing of loaded resources, drawn by the `loadedSummary` render
// hook as one summary line while collapsed, and as upstream's full listing when expanded
// (ctrl+o). Without the hook, or when it declines, the listing is drawn as upstream does.
import type { Component } from "@earendil-works/pi-tui";
import { renderHooks } from "./render-hooks.ts";

export class LoadedSummary implements Component {
	private readonly sections: ReadonlyArray<{ name: string; count: number }>;
	private readonly listing: Component & { setExpanded(expanded: boolean): void };
	private expanded: boolean;

	constructor(
		sections: ReadonlyArray<{ name: string; count: number }>,
		listing: Component & { setExpanded(expanded: boolean): void },
		expanded: boolean,
	) {
		this.sections = sections;
		this.listing = listing;
		this.expanded = expanded;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.listing.setExpanded(expanded);
	}

	render(width: number): string[] {
		if (!this.expanded) {
			const lines = renderHooks.loadedSummary?.(this.sections, width);
			if (lines) return lines;
		}
		return this.listing.render(width);
	}

	invalidate(): void {
		this.listing.invalidate();
	}
}
