// Shared by the phone's glass: the tints of glass a session can have, and the
// small WebGL plumbing the facets and the orb both use.

// Seven tints of glass, dark and barely saturated: the site's dark spectrum (da.css --spectrum-*) raised in lightness,
// OKLCH L 0.60 to 0.72, C 0.04 to 0.07. Linear-ish RGB in 0..1, as the shaders take them.
export const TINTS = [
	{ name: "smoke", rgb: [0.47, 0.56, 0.7] },
	{ name: "water", rgb: [0.45, 0.62, 0.55] },
	{ name: "amber", rgb: [0.72, 0.6, 0.43] },
	{ name: "clay", rgb: [0.72, 0.52, 0.5] },
	{ name: "amethyst", rgb: [0.6, 0.52, 0.7] },
	{ name: "teal", rgb: [0.42, 0.62, 0.66] },
	{ name: "slate", rgb: [0.56, 0.58, 0.62] },
];

/** The tint of a session, stable for its life: from its path (or id), never from its position in a list. */
export function tintOf(key) {
	let hash = 2166136261;
	for (const char of String(key ?? "")) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
	return TINTS[(hash >>> 0) % TINTS.length];
}

/** The same tint as a CSS colour, for what is drawn outside the canvases (labels' dots, the beam). */
export function tintCss(tint, alpha = 1) {
	const [r, g, b] = tint.rgb.map((v) => Math.round(v * 255));
	return `rgb(${r} ${g} ${b} / ${alpha})`;
}

export function compile(gl, vertex, fragment) {
	const program = gl.createProgram();
	for (const [type, source] of [
		[gl.VERTEX_SHADER, vertex],
		[gl.FRAGMENT_SHADER, fragment],
	]) {
		const shader = gl.createShader(type);
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader");
		gl.attachShader(program, shader);
	}
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link");
	gl.useProgram(program);
	const buffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
	const a = gl.getAttribLocation(program, "a");
	gl.enableVertexAttribArray(a);
	gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
	return program;
}

/** A WebGL context for a canvas: WebGL 2 first (the Android emulator's WebView refuses WebGL 1), else WebGL 1. */
export function context(canvas, options) {
	return canvas.getContext("webgl2", options) ?? canvas.getContext("webgl", options);
}

export const VERTEX = "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}";

/** Keeps a canvas's drawing buffer at its CSS size times the device's pixel ratio (capped: a phone's 3x costs). */
export function fit(canvas, maxRatio = 2) {
	const ratio = Math.min(window.devicePixelRatio || 1, maxRatio);
	const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
	const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
	}
	return ratio;
}

/** Whether animations are wanted: the window's `animations` setting and the system's reduced motion. */
export function moving() {
	return document.documentElement.dataset.motion !== "off" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
