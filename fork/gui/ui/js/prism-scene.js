// The welcome's prism: vector layers in index.html, drawn by the browser at the
// screen's resolution instead of the site's shader at a fraction of it. Per frame this moves only small things: the
// dust in the beam (its own canvas, the beam's size), the crossfade of the two fans, and each layer by a few pixels
// with the pointer, the nearer ones more. The blurred layers are never repainted. The glass is a regular prism: its
// back triangle is the front one moved by one vector, (230, 40), so its edges in depth are parallel.

// The frame of the drawing (viewBox) and the beam in it: from off the left edge to where it enters the glass.
const FRAME = [1600, 900];
const BEAM = [
	[-40, 452],
	[657, 371],
];
// Where the frame is centred when the window crops it, in the frame's units: between the glass and the spectrum
// leaving it, so a narrow window keeps the start of the spectrum instead of the frame's middle.
const FOCUS_X = 900;
// Room around the beam for the dust, in the frame's units.
const DUST_BOX = { x: -40, y: 300, w: 720, h: 220 };
const DUST = 90;
const FAN_MS = 11_000;
// How far each layer follows the pointer, in pixels: the nearer, the more.
const DEPTH = { "ps-back": 3, "ps-fan": 6, "ps-dust": 12, "ps-glass": 9 };

export class PrismScene {
	constructor(root) {
		this.root = root;
		this.layers = [...root.children].map((el) => [el, DEPTH[[...el.classList].find((name) => name in DEPTH)] ?? 0]);
		this.svgs = [...root.querySelectorAll("svg")];
		this.dust = root.querySelector(".ps-dust");
		this.ctx = null;
		this.fanB = root.querySelector(".ps-fan-b");
		this.box = null;
		this.size = [0, 0];
		// Each mote: where along the beam (u), how far off it (v, in frame units), its speed, size and phase.
		this.motes = Array.from({ length: DUST }, (_, i) => ({
			u: Math.random(),
			v: (Math.random() + Math.random() + Math.random() - 1.5) * 34,
			speed: 0.006 + Math.random() * 0.012,
			r: 0.5 + Math.random() * 1.1,
			phase: (i * 2.39996) % (Math.PI * 2),
		}));
		this.last = 0;
	}

	// Frames the drawing for the current size (each layer's viewBox) and lays the dust canvas over the beam; true when
	// the size changed.
	#place() {
		const width = this.root.clientWidth;
		const height = this.root.clientHeight;
		if (width === this.size[0] && height === this.size[1] && this.box) return false;
		this.size = [width, height];
		const scale = Math.max(width / FRAME[0], height / FRAME[1]);
		const left = Math.min(0, Math.max(width - FRAME[0] * scale, width / 2 - FOCUS_X * scale));
		const top = (height - FRAME[1] * scale) / 2;
		const view = `${(-left / scale).toFixed(2)} ${(-top / scale).toFixed(2)} ${(width / scale).toFixed(2)} ${(height / scale).toFixed(2)}`;
		for (const svg of this.svgs) svg.setAttribute("viewBox", view);
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.box = { scale, left, top, dpr };
		const style = this.dust.style;
		style.left = `${left + DUST_BOX.x * scale}px`;
		style.top = `${top + DUST_BOX.y * scale}px`;
		style.width = `${DUST_BOX.w * scale}px`;
		style.height = `${DUST_BOX.h * scale}px`;
		this.dust.width = Math.max(1, Math.round(DUST_BOX.w * scale * dpr));
		this.dust.height = Math.max(1, Math.round(DUST_BOX.h * scale * dpr));
		this.ctx = this.dust.getContext("2d");
		return true;
	}

	/** One frame at `now` (ms), the pointer eased to `mouse` (-1…1 on each axis); `still` draws without motion. */
	draw(now, mouse = [0, 0], still = false) {
		this.#place();
		const dt = still || !this.last ? 0 : Math.min(0.1, (now - this.last) / 1000);
		this.last = now;
		for (const [el, depth] of this.layers) {
			if (depth) el.style.transform = `translate(${mouse[0] * depth}px, ${mouse[1] * depth}px) scale(1.02)`;
		}
		this.#dust(now, dt, still);
		this.fanB.style.opacity = still ? "0.5" : String(0.5 + 0.5 * Math.sin((now / FAN_MS) * Math.PI * 2));
	}

	#dust(now, dt, still) {
		const { ctx, box } = this;
		if (!ctx) return;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.dust.width, this.dust.height);
		const k = box.scale * box.dpr;
		ctx.setTransform(k, 0, 0, k, -DUST_BOX.x * k, -DUST_BOX.y * k);
		const [[x0, y0], [x1, y1]] = BEAM;
		const length = Math.hypot(x1 - x0, y1 - y0);
		const nx = -(y1 - y0) / length;
		const ny = (x1 - x0) / length;
		// The mote colour follows the appearance; read again only when it changes, not each frame.
		const appearance = document.documentElement.dataset.appearance;
		if (appearance !== this.appearance) {
			this.appearance = appearance;
			this.ink = getComputedStyle(this.root).getPropertyValue("--ps-dust").trim() || "255 255 255";
		}
		const ink = this.ink;
		for (const mote of this.motes) {
			if (!still) mote.u = (mote.u + mote.speed * dt) % 1;
			// Brightest in the beam's core and toward the glass, twinkling slowly.
			const near = Math.exp(-((mote.v / 22) ** 2));
			const twinkle = still ? 0.7 : 0.55 + 0.45 * Math.sin(now / 900 + mote.phase);
			const alpha = (0.15 + 0.65 * near) * twinkle * (0.35 + 0.65 * mote.u);
			const x = x0 + (x1 - x0) * mote.u + nx * mote.v;
			const y = y0 + (y1 - y0) * mote.u + ny * mote.v;
			ctx.fillStyle = `rgb(${ink} / ${alpha.toFixed(3)})`;
			ctx.beginPath();
			ctx.arc(x, y, mote.r / box.scale, 0, Math.PI * 2);
			ctx.fill();
		}
	}

}
