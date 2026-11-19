// What is math in a Markdown text: the terminal's rules (packages/tui/src/components/markdown.ts, tokenizeInlineLatex
// and tokenizeBlockLatex), ported unchanged so the window and the terminal agree on it.
// - inline: $…$, $$…$$, \(…\), \[…\] on one line; "$" is not math when a space follows the opening "$" or precedes
//   the closing one, a digit follows the closing one ("$5 and $10"), the text is a shell-like name followed by a word
//   ("$HOME/$USER"), or it holds a backquote;
// - block: $$…$$ or \[…\] starting a line, over several lines;
// - pending (a reply still streaming): an opening delimiter without its closing one, kept as text with `pending`;
//   an opening "$" counts only when what follows looks like math.
// Tokens: { type: "latex" | "latexBlock", raw, text, pending? }.

function isEscaped(source, index) {
	let backslashes = 0;
	for (let position = index - 1; position >= 0 && source[position] === "\\"; position--) backslashes++;
	return backslashes % 2 === 1;
}

function findClosingDelimiter(source, closing, start) {
	let index = source.indexOf(closing, start);
	while (index >= 0 && isEscaped(source, index)) index = source.indexOf(closing, index + closing.length);
	return index;
}

function looksLikePendingDollarMath(source) {
	return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source);
}

export function tokenizeInlineLatex(source) {
	let opening = "";
	let closing = "";
	if (source.startsWith("$$")) {
		opening = "$$";
		closing = "$$";
	} else if (source.startsWith("\\(")) {
		opening = "\\(";
		closing = "\\)";
	} else if (source.startsWith("\\[")) {
		opening = "\\[";
		closing = "\\]";
	} else if (source.startsWith("$") && !/^\$\s/.test(source)) {
		opening = "$";
		closing = "$";
	} else {
		return undefined;
	}

	const closingIndex = findClosingDelimiter(source, closing, opening.length);
	if (
		closingIndex >= 0 &&
		opening === "$" &&
		(/\s$/.test(source.slice(opening.length, closingIndex)) ||
			/^\d/.test(source.slice(closingIndex + 1)) ||
			(/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(source.slice(opening.length, closingIndex)) &&
				/^[A-Za-z_][A-Za-z0-9_]*/.test(source.slice(closingIndex + 1))) ||
			source.slice(opening.length, closingIndex).includes("`"))
	) {
		return undefined;
	}

	if (closingIndex < 0) {
		const pendingSource = source.slice(opening.length);
		// fork: a shell-like name ($APP_CONFIG, $HOME/...) is not a formula being written; as pending it kept the rest
		// of the paragraph raw, Markdown and all, even once the reply was finished.
		if (opening === "$" && /^[A-Z_][A-Z0-9_]+(?![A-Za-z0-9_])/.test(pendingSource)) {
			return undefined;
		}
		if (opening.startsWith("\\") || looksLikePendingDollarMath(pendingSource)) {
			return { type: "latex", raw: source, text: pendingSource, pending: true };
		}
		return undefined;
	}

	const text = source.slice(opening.length, closingIndex);
	if (!text || text.includes("\n")) return undefined;

	const raw = source.slice(0, closingIndex + closing.length);
	return { type: "latex", raw, text };
}

export function tokenizeBlockLatex(source) {
	const dollarMatch = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
	if (dollarMatch?.[1]) return { type: "latexBlock", raw: dollarMatch[0], text: dollarMatch[1].trim() };

	const bracketMatch = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
	if (bracketMatch?.[1]) return { type: "latexBlock", raw: bracketMatch[0], text: bracketMatch[1].trim() };

	const pendingBracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
	if (pendingBracket) return { type: "latexBlock", raw: pendingBracket[0], text: pendingBracket[1], pending: true };
	const pendingDollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
	if (pendingDollar?.[1] && looksLikePendingDollarMath(pendingDollar[1])) {
		return { type: "latexBlock", raw: pendingDollar[0], text: pendingDollar[1], pending: true };
	}
	return undefined;
}

/** marked's tokenizer extensions for the two kinds (block first, as in the terminal). */
export const LATEX_EXTENSIONS = [
	{
		name: "latexBlock",
		level: "block",
		start(source) {
			const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
			return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined;
		},
		tokenizer: tokenizeBlockLatex,
	},
	{
		name: "latex",
		level: "inline",
		start(source) {
			const indices = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\[")].filter((index) => index >= 0);
			return indices.length > 0 ? Math.min(...indices) : undefined;
		},
		tokenizer: tokenizeInlineLatex,
	},
];
