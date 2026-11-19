// The dark room's beam: a ray of light along the top of the composer. At rest a
// faint hairline; while the model works it swells into waves of light tinted around the session's glass, overlapping
// and adding where they cross, as tall and as lively as the work is intense. The intensity is how fast the transcript
// changes (tokens arriving, tools running), smoothed. Canvas 2D: a strip 3.5rem tall (phone.css), drawn only while it moves.

import { fit, moving } from "./glass.js";

/** The tint made vivid: light through the glass, not the glass itself (as band.js's orb). */
function vivid(rgb) {
	const mean = (rgb[0] + rgb[1] + rgb[2]) / 3;
	return rgb.map((v) => Math.round(Math.min(1, (mean + (v - mean) * 3) * 1.15) * 255));
}

export class Beam {
	constructor(composer, transcript) {
		this.canvas = document.createElement("canvas");
		this.canvas.className = "phone-beam";
		this.canvas.setAttribute("aria-hidden", "true");
		composer.prepend(this.canvas);
		this.ctx = this.canvas.getContext("2d");
		this.colours = [
			[200, 210, 230],
			[200, 210, 230],
			[200, 210, 230],
		];
		this.changes = 0;
		this.target = 0;
		this.level = 0;
		this.start = performance.now();
		this.drawing = false;
		new MutationObserver((records) => {
			this.changes += records.length;
		}).observe(transcript, { childList: true, subtree: true, characterData: true });
		setInterval(() => this.tick(), 250);
		new ResizeObserver(() => this.draw()).observe(this.canvas);
	}

	/** The shown session's tint and its neighbours': the waves' three colours. */
	tint(tints) {
		this.colours = tints.map((tint) => vivid(tint.rgb));
		this.draw();
	}

	tick() {
		const working = document.body.dataset.working === "true";
		// Changes per second, a quarter of a second at a time.
		const rate = this.changes * 4;
		this.changes = 0;
		this.target = working ? Math.min(1, 0.35 + rate / 60) : 0;
		document.documentElement.style.setProperty("--phone-intensity", this.target.toFixed(2));
		if (!this.drawing && (this.target > 0 || this.level > 0.002)) {
			this.drawing = true;
			requestAnimationFrame(() => this.frame());
		}
	}

	frame() {
		// Smoothed over about half a second: the waves swell and settle, they do not jump.
		this.level += (this.target - this.level) * 0.06;
		this.draw();
		if (this.target > 0 || this.level > 0.002) requestAnimationFrame(() => this.frame());
		else {
			this.level = 0;
			this.drawing = false;
			this.draw();
		}
	}

	draw() {
		const canvas = this.canvas;
		if (!canvas.clientWidth) return;
		const ratio = fit(canvas);
		const ctx = this.ctx;
		const width = canvas.width;
		const height = canvas.height;
		// The ray runs at the composer's edge, 71 % down the canvas (phone.css): the waves rise above it and dip only a
		// little below, so they stay off the text of the composer.
		const middle = height * 0.71;
		const below = (height - middle) / middle;
		const light = document.documentElement.dataset.appearance === "light";
		ctx.clearRect(0, 0, width, height);
		const time = moving() ? (performance.now() - this.start) / 1000 : 2;
		const level = this.level;
		// The waves: each a lens of light between a curve and its mirror, under an envelope that wanders slowly.
		if (level > 0.002) {
			ctx.globalCompositeOperation = light ? "multiply" : "lighter";
			const waves = [
				{ colour: this.colours[0], freq: 2.2, speed: 1.3, amp: 1, centre: 0.5, spread: 0.24 },
				{ colour: this.colours[1], freq: 3.1, speed: -1.0, amp: 0.8, centre: 0.38, spread: 0.2 },
				{ colour: this.colours[2], freq: 2.7, speed: 0.8, amp: 0.75, centre: 0.62, spread: 0.2 },
				{ colour: this.colours[0], freq: 4.3, speed: 1.7, amp: 0.55, centre: 0.5, spread: 0.3 },
			];
			for (const [k, wave] of waves.entries()) {
				const centre = wave.centre + 0.06 * Math.sin(time * 0.4 + k * 1.7);
				const top = [];
				for (let i = 0; i <= 96; i++) {
					const x = i / 96;
					const envelope = Math.exp(-(((x - centre) / wave.spread) ** 2));
					const swing = Math.abs(Math.sin(x * wave.freq * Math.PI * 2 + time * wave.speed + k));
					top.push([x * width, middle - (middle - 2 * ratio) * level * wave.amp * envelope * (0.35 + 0.65 * swing)]);
				}
				const [r, g, b] = wave.colour;
				const gradient = ctx.createLinearGradient(0, 0, 0, height);
				const alpha = light ? 0.35 : 0.55;
				gradient.addColorStop(0, `rgb(${r} ${g} ${b} / 0)`);
				gradient.addColorStop(0.71, `rgb(${r} ${g} ${b} / ${alpha})`);
				gradient.addColorStop(1, `rgb(${r} ${g} ${b} / 0)`);
				ctx.fillStyle = gradient;
				ctx.beginPath();
				ctx.moveTo(top[0][0], top[0][1]);
				for (const [x, y] of top) ctx.lineTo(x, y);
				for (let i = top.length - 1; i >= 0; i--) ctx.lineTo(top[i][0], middle + (middle - top[i][1]) * below);
				ctx.closePath();
				ctx.fill();
			}
			ctx.globalCompositeOperation = "source-over";
		}
		// The hairline: the ray itself, brightest where the waves are.
		const line = ctx.createLinearGradient(0, 0, width, 0);
		const ink = light ? "0 0 0" : "255 255 255";
		const glow = 0.35 + 0.65 * level;
		line.addColorStop(0, `rgb(${ink} / 0)`);
		line.addColorStop(0.25, `rgb(${ink} / ${0.3 * glow})`);
		line.addColorStop(0.5, `rgb(${ink} / ${0.6 * glow})`);
		line.addColorStop(0.75, `rgb(${ink} / ${0.3 * glow})`);
		line.addColorStop(1, `rgb(${ink} / 0)`);
		ctx.fillStyle = line;
		ctx.fillRect(0, middle - ratio * (0.5 + level * 0.5), width, ratio * (1 + level));
	}
}
