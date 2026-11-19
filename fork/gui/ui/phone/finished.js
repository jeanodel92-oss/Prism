// The home's "Done": a conversation whose turn ended while the reader was not looking at it, the
// home on screen or another conversation. It lasts until that conversation is on screen again or works again. A turn
// cut by a lost link is not a finished turn.

export class Finished {
	constructor() {
		this.paths = new Set();
		this.streaming = new Map();
	}

	/** `views`: the open conversations ({ path, streaming, closed, lostLink }); `watched`: the one on screen, if any;
	 * `lost`: the PC cannot be reached. Called at each change of the conversations. */
	track(views, watched, lost) {
		const open = new Set();
		for (const view of views) {
			open.add(view.path);
			const cut = lost || view.closed || view.lostLink;
			if (this.streaming.get(view.path) && !view.streaming && view !== watched && !cut) this.paths.add(view.path);
			if (view === watched || view.streaming) this.paths.delete(view.path);
			this.streaming.set(view.path, Boolean(view.streaming));
		}
		for (const path of this.paths) if (!open.has(path)) this.paths.delete(path);
		for (const path of this.streaming.keys()) if (!open.has(path)) this.streaming.delete(path);
	}

	has(path) {
		return this.paths.has(path);
	}
}
