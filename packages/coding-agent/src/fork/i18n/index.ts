/**
 * fork: Prism's interface in English or French.
 *
 * The English text shown today is the key; `fr.ts` holds its translation. `t()` returns the
 * translation in the active language, or the English text when there is none, so an upstream text
 * change only leaves that text in English. Texts with variable parts use patterns with `{0}`,
 * `{1}`…: a variable part is kept as it is, unless it is itself an exact entry of the catalog
 * ("Thinking blocks: {0}" with "hidden", a permission reason with its detail). A text made of several sentences that has no
 * entry of its own is translated sentence by sentence (descriptions are often a fixed text plus
 * "Takes effect at the next start." or the like).
 *
 * The `language` setting is "auto" (default), "en" or "fr"; "auto" follows the system locale
 * (LC_ALL, LC_MESSAGES, LANG, in gettext's order).
 */
import { own } from "../own.ts";
import { FR, FR_PATTERNS } from "./fr.ts";

export type Language = "en" | "fr";
export type LanguageSetting = "auto" | Language;

let active: Language = "en";

/** The system's interface language: French for a `fr*` locale, English otherwise. */
export function systemLanguage(env: NodeJS.ProcessEnv = process.env): Language {
	const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
	return /^fr([_.@-]|$)/i.test(locale) ? "fr" : "en";
}

export function resolveLanguage(setting: unknown, env: NodeJS.ProcessEnv = process.env): Language {
	return setting === "en" || setting === "fr" ? setting : systemLanguage(env);
}

export function setLanguage(language: Language): void {
	active = language;
}

export function getLanguage(): Language {
	return active;
}

interface Pattern {
	regex: RegExp;
	target: string;
	/** Slot numbers in the order they appear in the English text, i.e. the regex groups. */
	order: number[];
}

export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `{0}` and the like match any text, shortest first, so the fixed parts decide. */
function compile(source: string, target: string): Pattern {
	const regex = new RegExp(
		`^${source
			.split(/(\{\d\})/)
			.map((part) => (/^\{\d\}$/.test(part) ? "([\\s\\S]*?)" : escapeRegex(part)))
			.join("")}$`,
	);
	return { regex, target, order: [...source.matchAll(/\{(\d)\}/g)].map((m) => Number(m[1])) };
}

const patterns: Pattern[] = Object.entries(FR_PATTERNS).map(([source, target]) => compile(source, target));

function translate(text: string): string | undefined {
	// A pattern's own key (fill()) takes its own translation, not the first shorter pattern it matches too.
	// fork: own entries only; `constructor` is not a translation.
	const exact = own(FR, text) ?? own(FR_PATTERNS, text);
	if (exact !== undefined) return exact;
	for (const { regex, target, order } of patterns) {
		const match = regex.exec(text);
		if (!match) continue;
		return target.replace(/\{(\d)\}/g, (_m, n: string) => {
			const part = match[order.indexOf(Number(n)) + 1] ?? "";
			return own(FR, part) ?? part;
		});
	}
	return undefined;
}

/**
 * `key` translated, its `{0}`, `{1}`… replaced by `values` as they are: one pass, so a value holding `$&`
 * or `{1}` is not rewritten, and never translated (a command name, a count, a path).
 */
export function fill(key: string, ...values: string[]): string {
	return t(key).replace(/\{(\d)\}/g, (slot, n: string) => values[Number(n)] ?? slot);
}

/** "Label: value", with the space French puts before the colon. */
export function labelled(label: string, value: string): string {
	return `${t(label)}${active === "fr" ? " :" : ":"} ${value}`;
}

/** `text` in the active language; English when no translation exists. */
export function t(text: string): string {
	if (active === "en" || !text) return text;
	const whole = translate(text);
	if (whole !== undefined) return whole;
	const sentences = text.split(/(?<=[.!?])(\s+)(?=[A-Z])/);
	if (sentences.length === 1) return text;
	// A sentence built from a label ("Appearance. Advanced settings only.") ends in a period its entry lacks.
	const sentence = (part: string) =>
		translate(part) ?? (part.endsWith(".") ? translate(part.slice(0, -1))?.concat(".") : undefined) ?? part;
	return sentences.map((part) => (/^\s+$/.test(part) ? part : sentence(part))).join("");
}
