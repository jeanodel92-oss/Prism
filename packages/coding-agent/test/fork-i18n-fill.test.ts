// fork: variable text is filled with fill(), never with t(key).replace() or
// t(`...${value}`). replace() read "$&" in a value as the matched slot, and a slot holding a catalog word was
// translated: "/ask" became "/demander".
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commandNotice, featureStates } from "../src/fork/feature-state.ts";
import { FR, FR_PATTERNS } from "../src/fork/i18n/fr.ts";
import { fill, setLanguage, t } from "../src/fork/i18n/index.ts";
import { LoginModelsChecklist } from "../src/fork/login-models.ts";
import { commandPrograms, plainAction } from "../src/fork/prism/plain-action.ts";
import { operationDetail } from "../src/fork/task-scope.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const model = (id: string) =>
	({
		id,
		name: id,
		api: "openai-responses",
		provider: "acme",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	}) as Model<"openai-responses">;

describe("fork: variable text is filled as it is", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => setLanguage("en"));

	it("keeps a value holding $& or a slot, in both languages", () => {
		for (const language of ["en", "fr"] as const) {
			setLanguage(language);
			expect(fill("Models from {0}", "a$&b $1 {1}")).toContain("a$&b $1 {1}");
			const list = new LoginModelsChecklist({
				providerName: "Ac$&me",
				models: [model("m1")],
				checked: [],
				onSave: () => {},
				onCancel: () => {},
			});
			expect(list.render(80).map(stripAnsi).join("\n")).toContain("Ac$&me");
		}
	});

	it("never translates a command name in a slot", () => {
		setLanguage("fr");
		const notice = commandNotice("sessions", false, () => ({ state: "off" }));
		expect(notice?.text).toBe(
			"/sessions : le module session-search est désactivé. Activez-le dans /settings › Modules.",
		);
		const unavailable = commandNotice("sessions", true, () => ({ state: "unavailable", why: "no model" }));
		expect(unavailable?.text).toMatch(/^\/sessions est indisponible : /);
	});

	it("fills a key with its own translation, not with a shorter pattern that matches it too", () => {
		// QA of fork.8 (VAL-08): "{0} tools" came first, so the reason a module is not supported read
		// "scripted cannot call tools (its server says so), and this module works through outils".
		setLanguage("fr");
		for (const [key, target] of Object.entries(FR_PATTERNS)) expect(t(key), key).toBe(FR[key] ?? target);
		const state = featureStates({
			enabled: new Set(["pi-goal", "capability-gates"]),
			withTools: new Set(["pi-goal"]),
			model: { id: "scripted", tools: { state: "no", source: "server" } },
			cwd: __dirname,
		})("pi-goal");
		expect(state.state === "unsupported" && state.why).toBe(
			"scripted ne sait pas appeler d'outils (son serveur le dit), et ce module passe par des outils",
		);
	});

	it("leaves no t(...).replace of a slot in the fork's sources", () => {
		const dir = join(__dirname, "../src/fork");
		const offenders = readdirSync(dir, { recursive: true, encoding: "utf8" })
			.filter((file) => file.endsWith(".ts"))
			.filter((file) => /\.replace\(\s*"\{(\d|n|total|query)\}"/.test(readFileSync(join(dir, file), "utf8")));
		expect(offenders).toEqual([]);
	});

	// Data the user, the model or a server provides: a catalog word ("Done"), replacement patterns, slots, an
	// unusual path with Unicode.
	const values = ["Done", "a$$b$&c$1{0}{1}", "/tmp/dossier é/文件 $& {0}/Ça.txt", "Help. Close", "😀 ünïcødé"];

	it("shows paths, commands and patterns as they are in the transcript's plain actions", () => {
		for (const language of ["en", "fr"] as const) {
			setLanguage(language);
			for (const value of values) {
				for (const tool of ["read", "edit", "write", "ls"])
					expect(plainAction(tool, { path: value })).toContain(value);
				expect(plainAction("grep", { pattern: value, path: value })?.split(value)).toHaveLength(3);
				expect(plainAction("find", { pattern: value })).toContain(value);
				expect(plainAction("bash", { command: value })).toContain(`(${commandPrograms(value).join(", ")})`);
			}
		}
		expect(plainAction("read", { path: "Done" })).toBe("Lecture de Done");
	});

	it("keeps a task scope's commands, files and hosts as they are, in English for the model", () => {
		setLanguage("fr");
		for (const value of values) {
			const operation = { what: value, commands: [value], writes: [value], hosts: [value] };
			const shown = operationDetail(operation);
			expect(shown.split(value)).toHaveLength(4);
			expect(shown).not.toContain("runs ");
			expect(operationDetail(operation, true)).toBe(`runs ${value} · changes ${value} · connects to ${value}`);
		}
	});
});
