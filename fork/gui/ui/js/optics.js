import { EclipseScene } from "./eclipse-scene.js";
import { PrismScene } from "./prism-scene.js";

// The welcome scene: the eclipse or the prism, chosen once per window, both Prism's own vector drawings
//. The prism shows on Prism's dark page and, in daylight, on
// its light one; the eclipse on the dark page. The scene stays behind the conversation, out of focus. Nothing runs
// while the welcome is hidden. Without a drawing in the page, the site's optical shader (site/optics.js, copied at
// build time) draws the phase instead, or its still image without WebGL, the site files, or animations.
//
// The shader draws on a canvas outside the page and the page shows a 2D copy of each frame
// WebKitGTK 2.54, composing a WebGL canvas of the page through its DMA-BUF renderer, shows a
// stale buffer of that canvas on alternate frames, black if that buffer was never drawn, an older frame if
// it was (the scene "shaking"). Measured on the test output: 18 of 27 captures alternate with the WebGL
// canvas shown, none with the 2D copy.

const SCALE = 0.75;
const MAX_PIXELS = 1.6e6;
const FRAME_MS = 1000 / 30;
// after a lost WebGL context the scene starts again on a new canvas, at most this many
// times within LOSS_WINDOW_MS; past that, it keeps its still image instead of flashing between the two.
const RETRY_MS = 1000;
const MAX_LOSSES = 3;
const LOSS_WINDOW_MS = 60_000;
// After a resize, the shader's canvas is made again at the new size once the size has held this long.
const RESIZE_MS = 150;
const ECLIPSE = 1;
const PRISM = 4;

export class WelcomeScene {
	constructor(container) {
		this.container = container;
		this.canvas = container.querySelector("canvas");
		this.phase = Math.random() < 0.5 ? ECLIPSE : PRISM;
		document.documentElement.dataset.scene = String(this.phase);
		const prism = container.querySelector(".prism-scene");
		const eclipse = container.querySelector(".eclipse-scene");
		this.arts = { [PRISM]: prism ? new PrismScene(prism) : null, [ECLIPSE]: eclipse ? new EclipseScene(eclipse) : null };
		this.drawnVector = false;
		this.optics = null;
		this.source = null;
		this.view = null;
		this.size = [1, 1];
		this.resized = 0;
		this.running = false;
		this.animate = false;
		this.wanted = false;
		this.drawn = false;
		this.losses = 0;
		this.lostAt = [];
		this.retry = 0;
		this.last = 0;
		this.start = performance.now();
		this.mouse = [0, 0];
		this.target = [0, 0];
		// The drawing loop under way: stopping starts a new one, so a frame asked before a stop and run after a resume
		// does not carry on as a second loop.
		this.loop = 0;
		this.lost = (event) => this.#lost(event);
		// As on the site: the pointer anywhere in the window steers the light, eased toward it. The scene
		// itself never receives pointer events (it lies under the welcome text, pointer-events: none).
		window.addEventListener(
			"pointermove",
			(event) => {
				// Any pointer but a finger (a real mouse in WebKitGTK may not report "mouse"; unverified).
				if (event.pointerType === "touch") return;
				this.target = [(event.clientX / window.innerWidth) * 2 - 1, (event.clientY / window.innerHeight) * 2 - 1];
			},
			{ passive: true },
		);
		new ResizeObserver(() => this.#resize()).observe(container);
		document.addEventListener("visibilitychange", () => this.#update());
	}

	setAnimated(animate) {
		this.wanted = animate;
		this.#update();
	}

	setVisible(visible) {
		this.visible = visible;
		this.#update();
	}

	/** Shows boot phase `phase` (1 eclipse, 4 prism) instead of the one drawn at random. */
	setPhase(phase) {
		this.phase = phase;
		document.documentElement.dataset.scene = String(phase);
		this.drawnVector = false;
		this.#update();
	}

	// Hiding fades the scene out (CSS opacity transition); it keeps moving until the fade ends, or it
	// would freeze mid-fade. #draw stops once the scene is hidden and fully transparent.
	#update() {
		const art = this.#artPhase();
		if (art !== this.artShown) {
			this.artShown = art;
			this.drawnVector = false;
			this.container.dataset.art = art === PRISM ? "prism" : "eclipse";
		}
		const vector = this.#vectorMode();
		this.container.classList.toggle("vector", vector);
		document.documentElement.dataset.sceneVector = String(vector);
		if (vector !== this.isVector && this.running) this.#stop();
		this.isVector = vector;
		// The vector scene runs only while the welcome shows: behind the conversation it is blurred, and redrawing what
		// moves under a blur would repaint the whole blurred layer each frame.
		const run = vector
			? this.wanted && !document.hidden && this.visible
			: this.wanted && Boolean(window.PrismOptics) && !this.#gaveUp() && !document.hidden && (this.visible || this.#showing());
		if (vector && !run && !this.drawnVector) {
			this.vector.draw(performance.now(), [0, 0], true);
			this.drawnVector = true;
		}
		if (run && vector && !this.running) {
			this.running = true;
			this.drawnVector = true;
			this.#next();
		} else if (run && !this.running) {
			// each showing draws on a context of its own.
			if (!this.optics) {
				this.#resize();
				this.#source();
				this.view = this.optics ? this.canvas.getContext("2d", { alpha: false }) : null;
			}
			if (this.optics) {
				this.running = true;
				this.#next();
			}
		} else if (!run && this.running) this.#stop();
		this.animate = this.running;
		this.#still();
	}

	// The still image stays until the shader's first frame is on screen: the canvas before it is black. The vector
	// drawings need none.
	#still() {
		this.container.classList.toggle("still", !this.isVector && (!this.running || !this.drawn));
	}

	// Daylight shows the prism, whichever phase was drawn.
	#artPhase() {
		return document.documentElement.dataset.appearance === "light" ? PRISM : this.phase;
	}

	/** The vector drawing shown, if the page has it. */
	get vector() {
		return this.arts[this.#artPhase()];
	}

	#vectorMode() {
		return Boolean(this.vector);
	}

	#showing() {
		return Number(getComputedStyle(this.container).opacity) > 0;
	}

	#gaveUp() {
		return this.lostAt.length >= MAX_LOSSES;
	}

	// The shader's canvas, made at the current size. Resizing it does not work: WebKitGTK 2.54 then
	// reports the new size as its drawing buffer but draws into a buffer of the old size, so the scene shows the old
	// frame stretched, cut, or its edge smeared, until the window closes.
	#source() {
		this.#release();
		this.source = document.createElement("canvas");
		[this.source.width, this.source.height] = this.size;
		this.source.addEventListener("webglcontextlost", this.lost);
		this.optics = window.PrismOptics.create(this.source);
	}

	// Gives the shader's context back: a page has few of them.
	#release() {
		this.source?.removeEventListener("webglcontextlost", this.lost);
		this.optics?.gl.getExtension("WEBGL_lose_context")?.loseContext();
		this.optics = null;
		this.source = null;
	}

	/** Asks the next frame of the loop under way. */
	#next() {
		const loop = this.loop;
		requestAnimationFrame((now) => this.#draw(now, loop));
	}

	// Ends the drawing and gives the context back, on a fresh canvas for the next showing.
	#stop() {
		this.running = false;
		this.loop++;
		this.drawn = false;
		if (this.isVector) return;
		this.#release();
		this.view = null;
		const canvas = document.createElement("canvas");
		this.canvas.replaceWith(canvas);
		this.canvas = canvas;
		this.#resize();
	}

	#lost(event) {
		if (event.target !== this.source) return;
		event.preventDefault();
		this.losses++;
		const now = performance.now();
		this.lostAt = [...this.lostAt.filter((at) => now - at < LOSS_WINDOW_MS), now];
		this.#stop();
		this.animate = false;
		this.#still();
		clearTimeout(this.retry);
		if (!this.#gaveUp()) this.retry = setTimeout(() => this.#update(), RETRY_MS);
	}

	#resize() {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const w = this.container.clientWidth * dpr * SCALE;
		const hgt = this.container.clientHeight * dpr * SCALE;
		const k = Math.min(1, Math.sqrt(MAX_PIXELS / Math.max(1, w * hgt)));
		const width = Math.max(1, Math.round(w * k));
		const height = Math.max(1, Math.round(hgt * k));
		this.size = [width, height];
		this.resized = performance.now();
		// Setting a canvas's size, even to the same value, clears it to black until the next frame.
		if (this.canvas.width !== width) this.canvas.width = width;
		if (this.canvas.height !== height) this.canvas.height = height;
	}

	#draw(now, loop) {
		if (!this.running || loop !== this.loop) return;
		if (!this.visible && !this.#showing()) {
			this.#update();
			return;
		}
		if (now - this.last >= FRAME_MS && this.isVector) {
			this.#ease(now);
			this.vector.draw(now, this.mouse);
		} else if (now - this.last >= FRAME_MS) {
			if ((this.source.width !== this.size[0] || this.source.height !== this.size[1]) && now - this.resized >= RESIZE_MS) {
				this.#source();
				if (!this.optics) {
					this.#stop();
					this.#update();
					return;
				}
			}
			this.#ease(now);
			// These two shader phases ignore M; move their image a little without changing its proportions.
			this.canvas.style.transform = `translate(${this.mouse[0] * 8}px, ${this.mouse[1] * 8}px) scale(1.04)`;
			this.optics.draw({
				t: (now - this.start) / 1000 + 20,
				s: this.phase,
				mx: this.mouse[0],
				my: this.mouse[1],
				screen: [0, 0, 0, 0],
				seed: 0,
				q: 1,
			});
			// Until the shader's canvas is made again after a resize, its last frame is stretched over the new size.
			this.view.drawImage(this.source, 0, 0, this.canvas.width, this.canvas.height);
			if (!this.drawn) {
				this.drawn = true;
				// The frame reaches the screen with the next one; the still image goes then.
				requestAnimationFrame(() => this.#still());
			}
		}
		this.#next();
	}

	// The pointer, eased toward where it is.
	#ease(now) {
		const dt = Math.min(0.1, (now - (this.last || now)) / 1000);
		this.last = now;
		const ease = 1 - Math.exp(-dt * 1.5);
		this.mouse = this.mouse.map((value, axis) => value + (this.target[axis] - value) * ease);
	}
}
