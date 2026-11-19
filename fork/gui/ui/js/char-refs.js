// fork: marked keeps character references ("&amp;", "&#169;") as written
// in its text tokens; the window shows them as characters, as the terminal does. Same table and rules as
// packages/tui/src/fork/character-references.ts: an unknown name stays as written, a decoded control becomes U+FFFD.

const NAMED = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00a0",
	copy: "©",
	reg: "®",
	trade: "™",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	laquo: "«",
	raquo: "»",
	bull: "•",
	middot: "·",
	deg: "°",
	plusmn: "±",
	times: "×",
	divide: "÷",
	euro: "€",
	pound: "£",
	yen: "¥",
	cent: "¢",
	sect: "§",
	para: "¶",
	larr: "←",
	rarr: "→",
	uarr: "↑",
	darr: "↓",
	harr: "↔",
	lArr: "⇐",
	rArr: "⇒",
	hArr: "⇔",
	le: "≤",
	ge: "≥",
	ne: "≠",
	asymp: "≈",
	infin: "∞",
	check: "✓",
};

const REFERENCE = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g;

function fromCodePoint(code) {
	if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\ufffd";
	if (code !== 0x09 && code !== 0x0a && (code < 0x20 || (code >= 0x7f && code <= 0x9f))) return "\ufffd";
	return String.fromCodePoint(code);
}

/** The text of a marked text token with its character references decoded. */
export function decodeCharacterReferences(text) {
	if (!text.includes("&")) return text;
	return text.replace(REFERENCE, (reference, decimal, hex, name) => {
		if (decimal !== undefined) return fromCodePoint(Number.parseInt(decimal, 10));
		if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16));
		return (name !== undefined && Object.hasOwn(NAMED, name) ? NAMED[name] : undefined) ?? reference;
	});
}
