/**
 * fork: Prism's animations, each with its own switch under the global one. The global
 * `animations` setting still turns them all off; `animationsOff` lists the ones turned off one by one.
 * Turned off, an animation draws its last frame and nothing moves.
 */

export const ANIMATIONS = [
	{ id: "intro", label: "Startup logo", description: "The logo draws itself in at start, and the setup's beam." },
	{
		id: "working",
		label: "Working line",
		description: "The glint, the shine and the input's pulse while Prism works.",
	},
	{
		id: "thinking",
		label: "Thinking label",
		description:
			"A shine across “Thinking…” while the model thinks; a thinking block unfolds when clicked or shown from the keyboard.",
	},
	{
		id: "tools",
		label: "Running tool",
		description:
			"The dot of a tool that is running breathes; its details unfold when clicked or shown from the keyboard.",
	},
	{
		id: "menus",
		label: "Opening menus",
		description: "Menus and panels unfold when they open, and panels fold when they close.",
	},
	{ id: "title", label: "Terminal title", description: "A spinner in the terminal's title while Prism works." },
] as const;

export type AnimationId = (typeof ANIMATIONS)[number]["id"];

/** What the settings say about animations: the global switch and the ones turned off. */
export interface AnimationSettings {
	animations?: boolean;
	animationsOff?: readonly string[];
	animationStyles?: unknown;
}

/** Whether animation `id` moves: animations on, this one not turned off. */
export function animationOn(settings: AnimationSettings, id: AnimationId): boolean {
	return (
		settings.animations !== false &&
		!(Array.isArray(settings.animationsOff) && settings.animationsOff.includes(id)) &&
		animationStyle(settings.animationStyles, id) !== "off"
	);
}

/** The first style always preserves the original renderer. No style adds a timer. */
export const ANIMATION_STYLES = {
	intro: ["default", "off", "wipe", "dissolve"],
	working: ["default", "off", "dots", "meter"],
	thinking: ["default", "off", "dots", "pulse"],
	tools: ["default", "off", "spinner", "meter"],
	menus: ["default", "off", "wipe", "slide"],
	title: ["default", "off", "dots"],
} as const;

export type AnimationStyle = (typeof ANIMATION_STYLES)[AnimationId][number];
export type AnimationStyles = Partial<Record<AnimationId, AnimationStyle>>;

export const STYLE_LABELS: Record<AnimationStyle, string> = {
	default: "Original",
	off: "off",
	wipe: "Wipe",
	dissolve: "Dissolve",
	dots: "Dots",
	meter: "Meter",
	pulse: "Pulse",
	spinner: "Spinner",
	slide: "Slide",
};

export function animationStyle(value: unknown, id: AnimationId): AnimationStyle {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "default";
	const style: unknown = (value as Record<string, unknown>)[id];
	return ANIMATION_STYLES[id].find((entry) => entry === style) ?? "default";
}

export function readAnimationStyles(value: unknown): AnimationStyles {
	return Object.fromEntries(ANIMATIONS.map(({ id }) => [id, animationStyle(value, id)]));
}

export const ANIMATION_PRESETS = ["Default", "Calm", "Lively", "off"] as const;
export type AnimationPreset = (typeof ANIMATION_PRESETS)[number];

export function animationPreset(preset: AnimationPreset): AnimationStyles {
	switch (preset) {
		case "Default":
			return readAnimationStyles({});
		case "off":
			return Object.fromEntries(ANIMATIONS.map(({ id }) => [id, "off"]));
		case "Calm":
			return { intro: "dissolve", working: "dots", thinking: "pulse", tools: "meter", menus: "wipe", title: "off" };
		case "Lively":
			return { intro: "wipe", working: "meter", thinking: "dots", tools: "spinner", menus: "slide", title: "dots" };
	}
}
