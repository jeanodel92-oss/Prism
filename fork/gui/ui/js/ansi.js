// Terminal lines (SGR colour codes) to DOM spans, for the views the engine renders (view.js). Text goes in
// through textContent and colours through the CSSOM: nothing in a line is ever parsed as HTML.

// The engine's cursor marker (pi-tui CURSOR_MARKER): where a focused field wants the caret.
const CURSOR = "\x1b_pi:c\x07";
const SEQUENCE = /\x1b\[([0-9;:]*)m|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;

const cube = [0, 95, 135, 175, 215, 255];

function color256(n) {
	if (n < 16) return `var(--ansi-${n})`;
	if (n >= 232) {
		const v = 8 + (n - 232) * 10;
		return `rgb(${v},${v},${v})`;
	}
	const i = n - 16;
	return `rgb(${cube[Math.floor(i / 36)]},${cube[Math.floor(i / 6) % 6]},${cube[i % 6]})`;
}

// Reads one extended colour (38/48 ;5;n or ;2;r;g;b) starting at codes[i]; returns [colour, next index].
function extended(codes, i) {
	if (codes[i + 1] === 5) return [color256(codes[i + 2] ?? 0), i + 3];
	if (codes[i + 1] === 2) return [`rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`, i + 5];
	return [undefined, i + 1];
}

function apply(style, params) {
	const codes = params === "" ? [0] : params.split(/[;:]/).map((code) => Number.parseInt(code || "0", 10));
	for (let i = 0; i < codes.length; ) {
		const code = codes[i];
		if (code === 38 || code === 48) {
			const [value, next] = extended(codes, i);
			style[code === 38 ? "fg" : "bg"] = value;
			i = next;
			continue;
		}
		if (code === 0) for (const key of Object.keys(style)) delete style[key];
		else if (code === 1) style.bold = true;
		else if (code === 2) style.dim = true;
		else if (code === 3) style.italic = true;
		else if (code === 4) style.underline = true;
		else if (code === 7) style.inverse = true;
		else if (code === 9) style.strike = true;
		else if (code === 22) {
			delete style.bold;
			delete style.dim;
		}
		else if (code === 23) delete style.italic;
		else if (code === 24) delete style.underline;
		else if (code === 27) delete style.inverse;
		else if (code === 29) delete style.strike;
		else if (code >= 30 && code <= 37) style.fg = `var(--ansi-${code - 30})`;
		else if (code === 39) delete style.fg;
		else if (code >= 40 && code <= 47) style.bg = `var(--ansi-${code - 40})`;
		else if (code === 49) delete style.bg;
		else if (code >= 90 && code <= 97) style.fg = `var(--ansi-${code - 82})`;
		else if (code >= 100 && code <= 107) style.bg = `var(--ansi-${code - 92})`;
		i++;
	}
}

function span(text, style) {
	const el = document.createElement("span");
	el.textContent = text;
	const fg = style.inverse ? (style.bg ?? "var(--view-bg)") : style.fg;
	const bg = style.inverse ? (style.fg ?? "var(--view-fg)") : style.bg;
	if (fg) el.style.color = fg;
	if (bg) el.style.backgroundColor = bg;
	if (style.bold) el.style.fontWeight = "600";
	if (style.dim) el.style.opacity = "0.6";
	if (style.italic) el.style.fontStyle = "italic";
	const lines = [style.underline && "underline", style.strike && "line-through"].filter(Boolean);
	if (lines.length) el.style.textDecoration = lines.join(" ");
	return el;
}

/** One terminal line as a fragment of spans; the cursor marker becomes an empty `.caret` span. */
export function ansiLine(line) {
	const fragment = document.createDocumentFragment();
	const style = {};
	let last = 0;
	const text = String(line ?? "");
	for (const match of text.matchAll(SEQUENCE)) {
		if (match.index > last) fragment.append(span(text.slice(last, match.index), style));
		last = match.index + match[0].length;
		if (match[1] !== undefined) apply(style, match[1]);
		else if (match[0] === CURSOR) fragment.append(Object.assign(document.createElement("span"), { className: "caret" }));
	}
	if (last < text.length) fragment.append(span(text.slice(last), style));
	return fragment;
}
