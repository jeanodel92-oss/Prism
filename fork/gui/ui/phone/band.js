// The quick switcher: a grip under the conversation's topbar, pulled down (or
// touched), lowers a band of glass holding the orb and a carousel of the sessions. The carousel follows the finger
// and settles on the nearest session when it lets go, the orb gliding to that session's tint; touching the orb or the
// centred card opens it, touching a side card brings it to the centre.

import { h } from "../js/dom.js";
import { t } from "../js/i18n.js";
import { Orb } from "./orb.js";

const PULL = 56; // px of pull that opens the band
const CARD = 0.5; // a card's width, as a share of the band's
const FLICK = 0.4; // px/ms: a slide that fast carries on to the next card

/** A tint made vivid for the orb's light: the glass tints are kept dark and grey on purpose, light through them is not. */
function glow(rgb) {
	const mean = (rgb[0] + rgb[1] + rgb[2]) / 3;
	return rgb.map((v) => Math.min(1, (mean + (v - mean) * 3) * 1.15));
}

export class Band {
	/** `items()` gives the sessions in order with the shown one's index: { items: [{title, tint}], at }. */
	constructor(items, onOpen) {
		this.items = items;
		this.onOpen = onOpen;
		this.grip = h("button", { type: "button", class: "phone-grip", "aria-label": t("phoneSwitch"), title: t("phoneSwitch") });
		this.canvas = h("canvas", { class: "phone-orb", "aria-hidden": "true" });
		this.track = h("div", { class: "phone-band-track" });
		this.count = h("div", { class: "phone-band-count", "aria-hidden": "true" });
		this.el = h(
			"div",
			{ class: "phone-band", hidden: true, role: "dialog", "aria-label": t("phoneSwitch") },
			this.canvas,
			h("div", { class: "phone-band-strip" }, this.track),
			this.count,
		);
		this.scrim = h("div", { class: "phone-band-scrim", hidden: true });
		document.body.append(this.scrim, this.el);
		this.orb = new Orb(this.canvas);
		this.bindPull(this.grip, true);
		this.#bindBand();
		this.scrim.addEventListener("click", () => this.close());
	}

	/** A pull down on `el` lowers the band with the finger; on the grip, a touch without a pull opens it too. */
	bindPull(el, tapOpens) {
		let start;
		const end = (event, cancelled) => {
			if (start === undefined) return;
			const pulled = event.clientY - start;
			start = undefined;
			this.el.style.removeProperty("--pull");
			if (this.el.hidden) return;
			// A pull too short closes it again.
			if (!cancelled && ((tapOpens && pulled < 6) || pulled >= PULL * 0.6)) this.open();
			else this.close();
		};
		el.addEventListener("pointerdown", (event) => {
			// Elsewhere than on the grip, the topbar's buttons keep their touches.
			if (el !== this.grip && event.target.closest("button, a, input, select, textarea, [role='button']")) return;
			start = event.clientY;
			el.setPointerCapture(event.pointerId);
		});
		el.addEventListener("pointermove", (event) => {
			if (start === undefined) return;
			const pulled = Math.max(0, event.clientY - start);
			if (pulled > 4 && this.el.hidden) this.open(false);
			this.el.style.setProperty("--pull", String(Math.min(1, pulled / PULL)));
		});
		el.addEventListener("pointerup", (event) => {
			if (tapOpens && start !== undefined && this.el.hidden && Math.abs(event.clientY - start) < 6) {
				start = undefined;
				this.open();
				return;
			}
			end(event, false);
		});
		el.addEventListener("pointercancel", (event) => end(event, true));
	}

	#bindBand() {
		let drag;
		this.el.addEventListener("pointerdown", (event) => {
			drag = { x: event.clientX, base: this.offset, moved: false, last: event.clientX, time: event.timeStamp, speed: 0 };
			this.track.classList.add("dragging");
			this.el.setPointerCapture(event.pointerId);
		});
		this.el.addEventListener("pointermove", (event) => {
			if (!drag) return;
			if (Math.abs(event.clientX - drag.x) > 8) drag.moved = true;
			const elapsed = event.timeStamp - drag.time;
			if (elapsed > 0) drag.speed = (drag.last - event.clientX) / elapsed;
			drag.last = event.clientX;
			drag.time = event.timeStamp;
			if (drag.moved) this.slide(drag.base + (drag.x - event.clientX) / this.cardWidth());
		});
		const end = (event, cancelled) => {
			if (!drag) return;
			const { moved, speed } = drag;
			drag = undefined;
			this.track.classList.remove("dragging");
			if (moved || cancelled) {
				// Settles on the nearest card, or the next one along a quick flick.
				const carry = Math.abs(speed) > FLICK ? Math.sign(speed) * 0.5 : 0;
				this.aim(Math.round(this.offset + carry));
				return;
			}
			const hit = document.elementFromPoint(event.clientX, event.clientY);
			const card = hit?.closest?.(".phone-band-card");
			if (card && Number(card.dataset.index) !== this.at) this.aim(Number(card.dataset.index));
			else if (card || this.canvas.contains(hit)) this.choose();
		};
		this.el.addEventListener("pointerup", (event) => end(event, false));
		this.el.addEventListener("pointercancel", (event) => end(event, true));
		this.el.addEventListener("keydown", (event) => {
			if (event.key === "ArrowLeft") this.aim(this.at - 1);
			else if (event.key === "ArrowRight") this.aim(this.at + 1);
			else if (event.key === "Enter") this.choose();
			else if (event.key === "Escape") this.close();
		});
	}

	cardWidth() {
		return Math.max(1, this.el.clientWidth * CARD);
	}

	open(settle = true) {
		const { items, at } = this.items();
		this.list = items;
		if (!this.list.length) return;
		const wasHidden = this.el.hidden;
		this.el.hidden = false;
		this.scrim.hidden = false;
		this.el.tabIndex = -1;
		if (wasHidden) {
			this.track.replaceChildren(
				...this.list.map((item, index) => h("div", { class: "phone-band-card", dataset: { index: String(index) } }, h("span", { text: item.title }))),
			);
			this.track.classList.add("dragging");
			this.aim(at);
		}
		// Lowered on the next frame, so the transition runs from the closed place.
		requestAnimationFrame(() => {
			this.track.classList.remove("dragging");
			this.el.classList.add("open");
			this.scrim.classList.add("open");
		});
		if (settle) this.el.focus({ preventScroll: true });
		this.orb.show(true);
	}

	close() {
		this.el.classList.remove("open");
		this.scrim.classList.remove("open");
		this.orb.show(false);
		setTimeout(() => {
			if (this.el.classList.contains("open")) return;
			this.el.hidden = true;
			this.scrim.hidden = true;
		}, 360);
	}

	/** Places the carousel at a fractional index (while a finger slides it); the orb follows the nearest card. */
	slide(offset) {
		const last = this.list.length - 1;
		// Past either end the cards resist: a third of the finger's travel.
		const held = offset < 0 ? offset / 3 : offset > last ? last + (offset - last) / 3 : offset;
		this.offset = held;
		const width = this.cardWidth();
		this.track.style.transform = `translateX(${(this.el.clientWidth - width) / 2 - held * width}px)`;
		for (const card of this.track.children) {
			const distance = Math.min(1, Math.abs(Number(card.dataset.index) - held));
			card.style.opacity = String(1 - distance * 0.6);
			card.style.transform = `scale(${1 - distance * 0.12})`;
			card.style.width = `${width}px`;
			// The neighbours' names lean towards the middle, so that a part of them shows at the edges.
			const side = Number(card.dataset.index) - held;
			card.style.textAlign = side > 0.5 ? "left" : side < -0.5 ? "right" : "center";
		}
		const nearest = Math.max(0, Math.min(last, Math.round(held)));
		if (nearest !== this.at) this.#mark(nearest);
	}

	/** Settles the carousel on a session. */
	aim(index) {
		const last = this.list.length - 1;
		const at = Math.max(0, Math.min(last, index));
		this.slide(at);
		this.#mark(at);
	}

	#mark(at) {
		const count = this.list.length;
		this.at = at;
		const item = this.list[at];
		const prev = this.list[Math.max(0, at - 1)];
		const next = this.list[Math.min(count - 1, at + 1)];
		this.orb.aim([glow(item.tint.rgb), glow(prev.tint.rgb), glow(next.tint.rgb)]);
		this.count.textContent = `${at + 1} / ${count}`;
		this.el.setAttribute("aria-label", `${t("phoneSwitch")} — ${item.title}`);
		for (const card of this.track.children) card.classList.toggle("current", Number(card.dataset.index) === at);
	}

	choose() {
		const item = this.list?.[this.at];
		this.close();
		if (item) this.onOpen(item);
	}
}
