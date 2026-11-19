// The phone's notices: Android says "waiting for your answer" and "done" for a conversation while
// the app is not on screen. They need the link kept in the background (the permanent notification, on by default):
// without it Android freezes the app and nothing arrives to tell. Back on screen, the app takes its notices away: the
// home says the same there.

/** A notice's number: one per conversation, so its latest state replaces the former one. Android wants a 32-bit int. */
export function noticeId(path) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193);
	return hash & 0x7fffffff;
}

export class Notices {
	/** `post({ id, title, kind })` shows a notice, `kind` being "waiting" or "done"; `clear(ids)` removes some. */
	constructor(post, clear) {
		this.post = post;
		this.clear = clear;
		this.streaming = new Map();
		this.told = new Map();
		this.posted = new Set();
	}

	/** `views`: the open conversations ({ path, title, streaming, dialogs, closed, lostLink }, `dialogs` a map of the
	 * open questions by their id); `hidden`: the app is not on screen; `lost`: the PC cannot be reached. Called at each
	 * change of the conversations and of the app's visibility. A turn cut by a lost link is not a finished turn; a
	 * question the PC shows again after a reconnection, under the same id, is not a new one; a conversation seen for the
	 * first time tells nothing. */
	track(views, hidden, lost) {
		const open = new Set();
		for (const view of views) {
			open.add(view.path);
			const cut = lost || view.closed || view.lostLink;
			const known = this.streaming.has(view.path);
			const told = this.told.get(view.path) ?? new Set();
			this.told.set(view.path, told);
			const fresh = view.closed ? [] : [...view.dialogs.keys()].filter((id) => !told.has(id));
			for (const id of fresh) told.add(id);
			if (hidden && !cut && known) {
				const id = noticeId(view.path);
				const kind = fresh.length > 0 ? "waiting" : view.dialogs.size === 0 && !view.streaming && this.streaming.get(view.path) ? "done" : undefined;
				if (kind) {
					this.posted.add(id);
					this.post({ id, title: view.title, kind });
				}
			}
			if (!cut) this.streaming.set(view.path, Boolean(view.streaming));
		}
		for (const map of [this.streaming, this.told]) for (const path of map.keys()) if (!open.has(path)) map.delete(path);
		if (!hidden && this.posted.size > 0) {
			this.clear([...this.posted]);
			this.posted.clear();
		}
	}
}
