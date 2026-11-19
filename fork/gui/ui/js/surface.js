// The interaction surface: the place above the composer where everything that is not conversation
// shows while it is open (a command's panel, a question from an extension, a view of the engine), as the
// terminal shows them in the editor's place. Nothing here ever goes into the transcript, and a closed
// interaction leaves nothing behind.
//
// Two rules keep it stable:
// - Geometry comes from the window, never from the space left by the surface's own content. The size the
//   engine renders views at, and the surface's maximum height, are a fraction of the main area's height,
//   which opening or closing an interaction does not change. (Deriving it from the transcript's height,
//   which the surface itself shrinks, made views oscillate between two sizes every frame.)
// - One interaction per command: running a command again while it is open closes it (a switch or its key)
//   or brings it back to the front (typed again), and another command first closes the open one.

const SURFACE_SHARE = 0.6; // of the main area's height
const CHROME = 56; // a panel's header, padding and border, in px, outside the rows of a view
const LINGER_MS = 160; // an answered question of a command waits this long for the next one
// Owners of what opens on its own, not from something the user ran: the agent's turn, an extension.
export const UNASKED_OWNERS = new Set(["agent", "extension"]);

/** The window's surface element: places the active session's interactions and sizes them. */
export class Surface {
	constructor(el, main, composer) {
		this.el = el;
		this.main = main;
		this.composer = composer;
		this.session = undefined;
		this.resize();
	}

	/** The maximum height of the surface, in px, from the main area alone. */
	get maxHeight() {
		return Math.max(160, Math.floor(this.main.clientHeight * SURFACE_SHARE));
	}

	/** Rows a view of the engine gets: what fits in the surface's maximum height. */
	rows(cellHeight) {
		return Math.max(8, Math.floor((this.maxHeight - CHROME) / cellHeight));
	}

	resize() {
		this.el.style.setProperty("--surface-max", `${this.maxHeight}px`);
	}

	/** Shows `session`'s interactions, in opening order; the composer gives way to one that replaces it. */
	place(session) {
		this.session = session;
		const entries = session?.interactions.entries ?? [];
		const wanted = new Set(entries.map((entry) => entry.panel.el));
		for (const el of [...this.el.querySelectorAll(":scope > .panel:not(.view-measure)")]) if (!wanted.has(el)) el.remove();
		for (const entry of entries) {
			if (entry.panel.el.parentNode === this.el) continue;
			this.el.append(entry.panel.el);
			// Shown again (its conversation is back on screen): what it computed on its content, such as the ranges of
			// a search, was emptied by its removal.
			entry.panel.el.dispatchEvent(new Event("panel-shown"));
		}
		this.composer.hidden = entries.some((entry) => entry.replacesComposer && !entry.closing);
		this.el.classList.toggle("open", entries.length > 0);
	}
}

/** One session's open interactions and the command that owns them. */
export class Interactions {
	constructor(session) {
		this.session = session;
		this.entries = [];
		this.command = undefined; // { name, done: Promise, dismissing }
		// Commands given up while still running (their end not awaited past the bound), by name: what they open
		// later is closed at once.
		this.revoked = new Map();
	}

	get app() {
		return this.session.app;
	}

	get #active() {
		return this.app.active === this.session;
	}

	/**
	 * Who an interaction that opens now belongs to: the command running, the footer's menu the user opened (more…,
	 * the context gauge), else the agent's turn or an extension.
	 */
	owner() {
		if (this.command) return this.command.name;
		// more… was owned by "extension" and a click beside it left it open.
		if (this.session.footerMenuOpen) return "footer";
		return this.session.streaming ? "agent" : "extension";
	}

	/**
	 * Adds an interaction: `{ panel, owner, replacesComposer?, focus?, onDismiss? }`. A question answered a
	 * moment ago by the same owner is replaced in place, so a menu of several screens stays one panel.
	 * `onDismiss` is how the maintainer closes it from outside (another command, the session closing).
	 */
	open(entry) {
		// While a command is being dismissed, what it still opens is cancelled at once; so is what a command given up
		// opens after another took its place.
		if ((this.command?.dismissing && entry.owner === this.command.name) || (this.revoked.has(entry.owner) && this.command?.name !== entry.owner)) {
			queueMicrotask(() => entry.onDismiss?.());
		}
		const lingering = this.entries.find((other) => other.closing && other.owner === entry.owner);
		if (lingering) {
			clearTimeout(lingering.timer);
			// This is still the open graphical menu, not another panel arriving after each changed field.
			if (lingering.nativeMenu && entry.nativeMenu) entry.panel.el.style.animation = "none";
			const index = this.entries.indexOf(lingering);
			this.entries[index] = entry;
			if (lingering.panel.el.parentNode) lingering.panel.el.replaceWith(entry.panel.el);
		} else this.entries.push(entry);
		if (this.#active) {
			this.app.surface.place(this.session);
			if (entry.focus) requestAnimationFrame(() => entry.panel.focus());
		}
		this.app.render();
	}

	/** Removes an interaction; `linger` keeps its place a moment for the next screen of the same owner. */
	close(entry, { linger = false } = {}) {
		if (!this.entries.includes(entry) || entry.closing) return;
		const hadFocus = entry.panel.el.contains(document.activeElement);
		const finish = () => {
			const index = this.entries.indexOf(entry);
			if (index < 0) return;
			this.entries.splice(index, 1);
			const focusGone = hadFocus || document.activeElement === document.body || !document.activeElement?.isConnected;
			if (this.#active) {
				this.app.surface.place(this.session);
				if (focusGone) this.app.focusAfterInteraction(this.session);
			}
			this.app.render();
		};
		if (!linger) return finish();
		entry.closing = true;
		entry.finish = finish;
		entry.panel.el.classList.add("closing");
		entry.timer = setTimeout(finish, LINGER_MS);
	}

	/** `owner` is done: nothing more takes the place of what it answered, which goes now. */
	#settle(owner) {
		for (const entry of this.entries.filter((other) => other.closing && other.owner === owner)) {
			clearTimeout(entry.timer);
			entry.finish();
		}
	}

	/**
	 * Closes what the user opened (a command's panels and views), for a click beside them.
	 * What opened on its own (a question of the agent's turn or of an extension) stays until it is answered.
	 */
	dismissOpened() {
		if (this.command) return this.#dismiss(this.command);
		for (const entry of [...this.entries]) if (!entry.closing && !UNASKED_OWNERS.has(entry.owner)) entry.onDismiss?.();
	}

	/** Closes every interaction (the session is closing or its engine stopped). */
	dismissAll() {
		for (const entry of [...this.entries]) {
			if (entry.closing) this.close(entry);
			else entry.onDismiss?.();
		}
	}

	/** The open interactions of `owner`. */
	of(owner) {
		return this.entries.filter((entry) => entry.owner === owner && !entry.closing);
	}

	/**
	 * Runs a command that may open interactions. A command already open is closed instead (`toggle`) or
	 * brought to the front; another open command is closed first, and its end awaited, so what it still
	 * opens is never taken for the new one's.
	 */
	async run(name, start, { toggle = false } = {}) {
		const current = this.command;
		// One being dismissed (Escape, a click beside it) is ending: the same command typed again opens anew once it has.
		// so is one whose panels are all closed but which still finishes (the window's /login refreshing
		// the models after its menu was closed); the second /login did nothing until then.
		if (current?.name === name && !current.dismissing && this.of(name).length > 0) {
			if (toggle) await this.#dismiss(current);
			else this.of(name).at(-1)?.panel.focus();
			return true;
		}
		if (current) await this.#dismiss(current);
		// The same command again while an earlier run of it was given up: what each opens could not be told apart, so
		// this one starts once that run has ended (another command does not wait for it).
		// Awaited only then: a run that starts sets its command at once, before any other run reads it.
		if (this.revoked.has(name)) await this.revoked.get(name);
		const command = { name, dismissing: false };
		this.command = command;
		command.done = Promise.resolve()
			.then(start)
			.finally(() => {
				if (this.command === command) this.command = undefined;
				this.#settle(name);
			});
		return command.done;
	}

	async #dismiss(command) {
		command.dismissing = true;
		for (const entry of this.of(command.name)) entry.onDismiss?.();
		// Bounded: a command that ignores its views being closed does not hold the next one forever.
		const ended = command.done?.catch(() => {});
		let late = false;
		await Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve((late = true)), 3000))]);
		if (late && ended) {
			// Given up: still running, so what it opens later is not shown (open), until it ends.
			const gone = ended.then(() => {
				if (this.revoked.get(command.name) === gone) this.revoked.delete(command.name);
			});
			this.revoked.set(command.name, gone);
		}
		if (this.command === command) this.command = undefined;
	}
}
