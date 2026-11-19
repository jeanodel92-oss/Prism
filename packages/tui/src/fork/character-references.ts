/**
 * fork: marked keeps character references ("&amp;", "&#169;") as written
 * in its text tokens, and its own renderer is what turns them into characters. The terminal shows the tokens, so it
 * decodes them here (CommonMark 0.31.2, "Entity and numeric character references").
 *
 * Named references cover the ones text commonly carries, not the whole HTML table: an unknown name stays as written,
 * which is also what CommonMark asks for a name that is not an entity. A decoded control character (other than a
 * newline or a tab) becomes U+FFFD, so a reference cannot put a terminal control on screen.
 */

const NAMED: Record<string, string> = {
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

function fromCodePoint(code: number): string {
	if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\ufffd";
	if (code !== 0x09 && code !== 0x0a && (code < 0x20 || (code >= 0x7f && code <= 0x9f))) return "\ufffd";
	return String.fromCodePoint(code);
}

/** The text of a marked text token with its character references decoded. */
export function decodeCharacterReferences(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(REFERENCE, (reference, decimal?: string, hex?: string, name?: string) => {
		if (decimal !== undefined) return fromCodePoint(Number.parseInt(decimal, 10));
		if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16));
		return (name !== undefined && Object.hasOwn(NAMED, name) ? NAMED[name] : undefined) ?? reference;
	});
}
