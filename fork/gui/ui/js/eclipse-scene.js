// The welcome's eclipse: vector layers in index.html, as the prism's (prism-scene.js), so
// both scenes are drawn alike at the screen's resolution (the site's shader beside the vector prism looked foreign)
// . Per frame this changes only the corona's slow breathing, the bright point's twinkle and each
// layer's offset with the pointer; the blurred layers are never repainted.

// The frame of the drawing (viewBox), and where it is centred when the window crops it: on the disc.
const FRAME = [1600, 900];
const FOCUS_X = 1130;
const CORONA_MS = 10_000;
const TWINKLE_MS = 4_200;
// How far each layer follows the pointer, in pixels: the nearer, the more.
const DEPTH = { "es-back": 3, "es-streak": 5, "es-disc": 8, "es-bead": 10 };

export class EclipseScene {
	constructor(root) {
		this.root = root;
		this.layers = [...root.children].map((el) => [el, DEPTH[[...el.classList].find((name) => name in DEPTH)] ?? 0]);
		this.svgs = [...root.querySelectorAll("svg")];
		this.corona = root.querySelector(".es-corona");
		this.bead = root.querySelector(".es-bead");
		this.size = [0, 0];
	}

	// Frames the drawing for the current size (each layer's viewBox).
	#place() {
		const width = this.root.clientWidth;
		const height = this.root.clientHeight;
		if (width === this.size[0] && height === this.size[1]) return;
		this.size = [width, height];
		const scale = Math.max(width / FRAME[0], height / FRAME[1]);
		const left = Math.min(0, Math.max(width - FRAME[0] * scale, width / 2 - FOCUS_X * scale));
		const top = (height - FRAME[1] * scale) / 2;
		const view = `${(-left / scale).toFixed(2)} ${(-top / scale).toFixed(2)} ${(width / scale).toFixed(2)} ${(height / scale).toFixed(2)}`;
		for (const svg of this.svgs) svg.setAttribute("viewBox", view);
	}

	/** One frame at `now` (ms), the pointer eased to `mouse` (-1…1 on each axis); `still` draws without motion. */
	draw(now, mouse = [0, 0], still = false) {
		this.#place();
		for (const [el, depth] of this.layers) {
			if (depth) el.style.transform = `translate(${mouse[0] * depth}px, ${mouse[1] * depth}px) scale(1.02)`;
		}
		const breath = still ? 0 : Math.sin((now / CORONA_MS) * Math.PI * 2);
		this.corona.style.opacity = String((0.85 + 0.15 * breath).toFixed(3));
		const twinkle = still ? 0 : Math.sin((now / TWINKLE_MS) * Math.PI * 2);
		this.bead.style.opacity = String((0.9 + 0.1 * twinkle).toFixed(3));
	}
}
