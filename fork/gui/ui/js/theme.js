// Colours come from the terminal's theme files (prism.json, prism-light.json), sent by the host. The
// window maps their roles to CSS variables and defines no colour of its own (da-site.md § 6).
// Window › Theme alone chooses which of the two is shown: the terminal's `theme` setting is the terminal's
//.

let themes = { dark: null, light: null };
let preference = "system";
let applied = [];

const media = window.matchMedia("(prefers-color-scheme: light)");

export function loadThemes([darkJson, lightJson]) {
	themes = { dark: JSON.parse(darkJson), light: JSON.parse(lightJson) };
	media.addEventListener("change", () => apply());
}

function resolve(theme, value, depth = 0) {
	if (typeof value !== "string" || value === "" || depth > 4) return undefined;
	if (value.startsWith("#")) return value;
	return resolve(theme, theme.vars?.[value], depth + 1);
}

function kebab(name) {
	return name.replace(/[A-Z0-9]+/g, (m) => `-${m.toLowerCase()}`);
}

/** The theme shown, by its terminal name, which the engine renders a conversation's views with (set_views). */
export function themeName() {
	return activeAppearance() === "light" ? "prism-light" : "prism";
}

export function setThemePreference(value) {
	preference = value === "dark" || value === "light" ? value : "system";
	apply();
}

export function activeAppearance() {
	return preference === "system" ? (media.matches ? "light" : "dark") : preference;
}

// The variables of a theme file (prism.json, prism-light.json).
function variables(appearance) {
	const theme = themes[appearance];
	if (!theme) return undefined;
	return {
		name: appearance === "light" ? "prism-light" : "prism",
		appearance,
		values: [
			...Object.keys(theme.vars ?? {}).map((n) => [kebab(n), resolve(theme, n)]),
			...Object.entries(theme.colors ?? {}).map(([n, value]) => [`c-${kebab(n)}`, resolve(theme, value)]),
			...Object.entries(theme.export ?? {}).map(([n, value]) => [`x-${kebab(n)}`, resolve(theme, value)]),
		],
	};
}

let appliedKey = "";

function apply() {
	const shown = variables(activeAppearance());
	if (!shown) return;
	// Rewriting the page's variables when nothing changed restyled the whole page.
	const key = JSON.stringify(shown);
	if (key === appliedKey) return;
	appliedKey = key;
	const style = document.documentElement.style;
	// A variable the new theme does not define does not keep the old theme's colour.
	for (const name of applied) style.removeProperty(`--${name}`);
	applied = [];
	for (const [name, color] of shown.values) {
		if (typeof color !== "string" || !color) continue;
		style.setProperty(`--${name}`, color);
		applied.push(name);
	}
	const changed = document.documentElement.dataset.appearance !== shown.appearance;
	document.documentElement.dataset.appearance = shown.appearance;
	document.documentElement.dataset.theme = shown.name;
	// The phone app paints Android's status and navigation bars with the page's colour (fork/android/android).
	window.PrismAndroid?.systemBars(style.getPropertyValue("--x-page-bg").trim(), shown.appearance === "light");
	// Drawings made for one appearance (diagram.js) are drawn again for the other.
	if (changed) document.dispatchEvent(new Event("prism-appearance"));
}
