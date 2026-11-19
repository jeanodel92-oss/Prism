import { visibleText } from "./visible-text.ts";

/** A bounded heuristic, not a security boundary. Never rewrites tool results. */
export const INJECTION_THRESHOLD = 3;
export const INJECTION_WINDOW = 64 * 1024;

export interface InjectionFinding {
	kind: string;
	excerpt: string;
}

/** Escape terminal controls and invisible Unicode before showing untrusted excerpts or sources. */
export function visibleInjectionText(text: string, limit = 180): string {
	return visibleText(text, { limit });
}

// Each variable repetition has a fixed upper bound or consumes a single character class without a suffix.
// Orders start a line/sentence/HTML text node; quoted examples inside ordinary prose do not match.
const ORDER =
	/(?:^|[\n.!?>])\s{0,16}(?:[-*#]\s{0,4})?(?:(?:system|assistant)\s{0,4}:\s{0,8})?(?:please\s{1,4})?(?:ignore|disregard|forget)\s{1,8}(?:all\s{1,4})?(?:the\s{1,4})?(?:previous|prior|above)\s{1,8}(?:instructions|prompts)\b/i;
const ROLE =
	/(?:^|[\n.!?>])\s{0,16}(?:you are now\s{1,8}(?:(?:an?|the)\s{1,4})?(?:(?:helpful|unrestricted|autonomous|ai)\s{1,4})?(?:assistant|agent|llm|language model|system|developer|administrator|admin|root|dan|unrestricted|in (?:developer|debug|admin|unrestricted|maintenance) mode)\b|new\s{1,4}(?:system\s{1,4})?instructions\s{0,4}:|do not\s{1,4}(?:tell|inform)\s{1,4}(?:the\s{1,4})?user\b|do not mention\b[\s\S]{0,160}\buser\b)/i;
const ADDRESSED =
	/\b(?:ai assistant|ai agent|llm|language model)\s{0,8}[:,!]\s{0,8}(?:you\s{1,4}(?:must|should)\s{1,4})?(?:run|execute|read|send|upload|post)\b[^\n.!?]{0,200}/i;
const ACTION = /(?:\b(?:run|execute)\b|\b(?:secret|credential|key|token|password)s?\b|https?:\/\/)/i;
const SIGNALS: ReadonlyArray<readonly [string, number, RegExp]> = [
	["Hidden Unicode tags", 3, /[\u{E0020}-\u{E007E}]+/u],
	[
		"Chat role switch",
		3,
		/<\|im_start\|>\s{0,8}(?:system|assistant)|<\|system\|>|\[INST\]|<<\/?SYS>>|<start_of_turn>\s{0,8}(?:system|model|user)/i,
	],
	["Instruction override", 3, ORDER],
	["Reader-directed instruction", 3, ROLE],
	["Zero-width run", 1, /[\u200B-\u200D\u2060\uFEFF]{3,}/u],
	["Bidirectional control", 1, /[\u202A-\u202E\u2066-\u2069]/u],
	["Role-like line", 1, /(?:^|\n)[ \t]{0,16}(?:system|assistant)\s{0,4}:/i],
];

export function detectInjection(text: string): { score: number; findings: InjectionFinding[] } {
	const findings = new Map<string, InjectionFinding>();
	let score = 0;
	// shortcut: the middle beyond two 64K UTF-16 windows is not scanned; expand only with measured need.
	const windows =
		text.length <= INJECTION_WINDOW * 2 ? [text] : [text.slice(0, INJECTION_WINDOW), text.slice(-INJECTION_WINDOW)];
	for (const window of windows) {
		const normalized = window.normalize("NFD").replace(/\p{M}/gu, "");
		const add = (kind: string, weight: number, match: RegExpExecArray | null) => {
			if (!match || findings.has(kind)) return;
			score += weight;
			findings.set(kind, { kind, excerpt: visibleInjectionText(match[0].trim()) });
		};
		for (const [kind, weight, pattern] of SIGNALS) add(kind, weight, pattern.exec(normalized));
		// Bounded segments with overlap keep proximity checks linear even on a single hostile long line.
		for (let offset = 0; offset < normalized.length; offset += 256) {
			const segment = normalized.slice(offset, offset + 512);
			const addressed = ADDRESSED.exec(segment);
			if (addressed && ACTION.test(addressed[0])) add("Agent-directed action", 3, addressed);
			if (/\b(?:decode|execute|follow|instruction|instructions)\b/i.test(segment))
				add("Encoded instruction", 1, /[A-Za-z0-9+/]{80,}={0,2}/.exec(segment));
		}
	}
	return { score, findings: [...findings.values()] };
}
