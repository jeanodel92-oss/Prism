// fork: fuzz targets for what a local model server answers during /login and capability detection.
// Replay with PI_FUZZ_SEED.
import { afterEach, expect, it, vi } from "vitest";
import {
	type DetectedServer,
	describeCapabilities,
	detectCapabilities,
	SAMPLING_KEYS,
	templateThinking,
} from "../src/fork/capabilities.ts";
import { listCompatibleServerModels } from "../src/fork/compatible-server.ts";

function makeRandom(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const seed = Number(process.env.PI_FUZZ_SEED ?? 4_211);

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Answers every request from `answer(method, path)`: a JSON value, a raw string body, or undefined for a 404. */
function stubServer(answer: (method: string, path: string) => unknown) {
	vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = answer(init?.method ?? "GET", `${url.pathname}${url.search}`);
		if (body === undefined) return new Response(null, { status: 404 });
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
	});
}

const TRI = new Set(["yes", "no", "unknown"]);
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "none"]);

function expectWellFormed(server: DetectedServer, ids: string[], label: string) {
	expect(["llama.cpp", "ollama", "lmstudio", "generic"], label).toContain(server.kind);
	expect(
		server.models.map((model) => model.id),
		label,
	).toEqual(ids);
	const count = (value: unknown) =>
		value === undefined || (typeof value === "number" && Number.isInteger(value) && value > 0);
	expect(count(server.slots), label).toBe(true);
	for (const model of server.models) {
		for (const flag of [model.vision, model.tools, model.reasoning]) expect(TRI.has(flag), label).toBe(true);
		expect(count(model.contextWindow) && count(model.maxContextWindow), label).toBe(true);
		expect(model.maxOutput === "unlimited" || count(model.maxOutput), label).toBe(true);
		for (const [key, value] of Object.entries(model.sampling ?? {})) {
			expect(SAMPLING_KEYS as readonly string[], label).toContain(key);
			expect(Number.isFinite(value), label).toBe(true);
		}
		for (const level of Object.values(model.thinking?.levels ?? {})) {
			expect(level === null || EFFORTS.has(level as string), label).toBe(true);
		}
	}
	expect(describeCapabilities(server), label).toHaveLength(ids.length + 1);
}

it("detects capabilities from arbitrary server answers without throwing or inventing values", async () => {
	const random = makeRandom(seed);
	const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
	const scalars: unknown[] = [null, true, false, 0, -1, 1.5, 4096, Number.MAX_SAFE_INTEGER, "8192", "", "x", [], {}];
	const template = () =>
		pick([
			"{% if enable_thinking %}",
			"{% if reasoning_effort == 'high' %}{% elif reasoning_effort == \"low\" %}",
			"{% if reasoning_effort in ['none', 'minimal', 'max'] %}",
			"{% if reasoning_effort not in (",
			"reasoning_effort in [",
			"reasoning_effort != 'bogus'",
			"",
		]);
	const value = (depth: number): unknown => {
		if (depth > 2 || random() < 0.4) return pick(scalars);
		if (random() < 0.3) return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
		return Object.fromEntries(
			Array.from({ length: Math.floor(random() * 4) }, () => [
				pick(["n_ctx", "value", "vision", "params", "id", "key", "data", "models", "status"]),
				value(depth + 1),
			]),
		);
	};
	const ids = ["m", "qwen:7b", "a/b"];
	const answers = (): Record<string, () => unknown> => ({
		"/props": () =>
			pick([
				undefined,
				"not json",
				value(0),
				{ role: "router" },
				{
					total_slots: pick(scalars),
					default_generation_settings: pick([
						value(0),
						{ n_ctx: pick(scalars), params: { n_predict: pick(scalars), temperature: pick(scalars) } },
					]),
					modalities: { vision: pick(scalars) },
					chat_template_caps: { supports_tool_calls: pick(scalars), supports_reasoning_effort: pick(scalars) },
					chat_template: pick([template(), template() + template(), pick(scalars)]),
				},
			]),
		"/slots": () => pick([undefined, value(0), [{ n_ctx: pick(scalars) }, value(1), null]]),
		"/v1/models": () =>
			pick([undefined, value(0), { data: [{ id: pick(ids), meta: { n_ctx_train: pick(scalars) } }, value(1)] }]),
		"/models": () =>
			pick([
				undefined,
				value(0),
				{ data: [{ id: pick(ids), aliases: value(1), status: { value: pick(["loaded", "sleeping", 1]) } }] },
			]),
		"/api/version": () => pick([undefined, value(0), { version: pick(["0.12.0", 1]) }]),
		"/api/show": () =>
			pick([
				undefined,
				value(0),
				{
					capabilities: pick([["vision", "tools", "thinking"], value(1), []]),
					model_info: { "llama.context_length": pick(scalars), x: value(1) },
					parameters: pick([
						"num_ctx 8192\ntemperature 0.6\nnum_predict -1",
						"num_ctx 1.2.3\ntemperature 1.2.3\ntop_k NaN",
						pick(scalars),
					]),
					thinking: { values: pick([[false], [true, "high"], value(1)]) },
				},
			]),
		"/api/v1/models": () =>
			pick([
				undefined,
				value(0),
				{
					models: [
						{
							key: pick(ids),
							max_context_length: pick(scalars),
							capabilities: pick([
								value(1),
								{ vision: pick(scalars), reasoning: { allowed_options: value(1) } },
							]),
							loaded_instances: pick([[{ config: { context_length: pick(scalars) } }], value(1)]),
						},
						value(1),
					],
				},
			]),
	});
	for (let index = 0; index < 600; index++) {
		const label = `seed=${seed} case=${index}`;
		const routes = answers();
		const fixed = new Map<string, unknown>();
		stubServer((_method, path) => {
			const route = path.split("?")[0]!;
			if (!fixed.has(route)) fixed.set(route, routes[route]?.());
			return fixed.get(route);
		});
		const server = await detectCapabilities("http://127.0.0.1:1/v1", ids);
		expectWellFormed(server, ids, `${label} ${JSON.stringify([...fixed])}`);
	}
});

it("reads the same thinking controls as the previous template regex", () => {
	// The list regex templateThinking replaced; only safe on small templates.
	const previous = (template: string) => {
		const values = new Set<string>();
		for (const match of template.matchAll(/reasoning_effort\s*[!=]=\s*["']([\w-]+)["']/g)) values.add(match[1]!);
		for (const match of template.matchAll(/reasoning_effort\s+(?:not\s+)?in\s+[[(]([^\])]*)[\])]/g)) {
			for (const quoted of match[1]!.matchAll(/["']([\w-]+)["']/g)) values.add(quoted[1]!);
		}
		return values;
	};
	const parts = ["reasoning_effort", " in ", " not in ", "[", "(", "]", ")", "'low'", '"high"', "'none'", ", ", "x"];
	parts.push("reasoning_effort in [", "reasoning_effort not in (", "reasoning_effort in (");
	parts.push("== 'max'", '!= "minimal"', "enable_thinking", "{% if ", " %}", "'medium'", "'xhigh'");
	const random = makeRandom(seed);
	for (let index = 0; index < 5_000; index++) {
		const template = Array.from(
			{ length: 1 + Math.floor(random() * 14) },
			() => parts[Math.floor(random() * parts.length)],
		).join("");
		const values = previous(template);
		const expected = ["minimal", "low", "medium", "high", "xhigh", "max"].filter((level) => values.has(level));
		const thinking = templateThinking(template);
		const label = JSON.stringify(template);
		if (!thinking) {
			expect(expected, label).toEqual([]);
			continue;
		}
		const accepted = Object.entries(thinking.levels)
			.filter(([level, value]) => level !== "off" && value !== null)
			.map(([level]) => level);
		expect(accepted, label).toEqual(expected.length > 0 ? expected : ["medium"]);
		expect(thinking.levels.off === "none", label).toBe(values.has("none"));
	}
});

it("stays fast on hostile chat templates and large slot lists", async () => {
	for (const template of [
		"reasoning_effort in [".repeat(40_000),
		`reasoning_effort in [${"'x', ".repeat(200_000)}`,
		"reasoning_effort ".repeat(100_000),
		`${"reasoning_effort ==".repeat(50_000)}'`,
	]) {
		const started = performance.now();
		templateThinking(template);
		expect(performance.now() - started).toBeLessThan(1_500);
	}
	stubServer((_method, path) =>
		path === "/props"
			? { total_slots: 4, default_generation_settings: { n_ctx: 4096 } }
			: path === "/slots"
				? Array.from({ length: 500_000 }, (_, slot) => ({ n_ctx: 4096 + slot }))
				: undefined,
	);
	const server = await detectCapabilities("http://127.0.0.1:1/v1", ["m"]);
	expect(server.models[0]!.contextWindow).toBe(4096);
}, 30_000);

it("rejects a model list of the wrong shape with its own message", async () => {
	const random = makeRandom(seed);
	const shapes: unknown[] = [
		null,
		42,
		"text",
		[],
		{},
		{ data: null },
		{ data: "x" },
		{ data: {} },
		{ data: [null, 1, "m"] },
		{ data: [{ id: 5 }] },
		"not json",
	];
	for (let index = 0; index < 200; index++) {
		const body = shapes[Math.floor(random() * shapes.length)];
		stubServer(() => body);
		const outcome = await listCompatibleServerModels("http://127.0.0.1:1/v1", undefined).then(
			(listed) => ({ listed }),
			(error: unknown) => ({ error }),
		);
		const label = `seed=${seed} case=${index} ${JSON.stringify(body)}`;
		if ("error" in outcome) {
			expect(outcome.error, label).toBeInstanceOf(Error);
			expect((outcome.error as Error).constructor, label).toBe(Error);
			expect((outcome.error as Error).message, label).toMatch(/model/i);
		} else {
			expect(outcome.listed.models.length, label).toBeGreaterThan(0);
			for (const id of outcome.listed.models) expect(typeof id, label).toBe("string");
		}
	}
	stubServer(() => ({ data: [null, { id: "m" }, { id: 7 }] }));
	expect((await listCompatibleServerModels("http://127.0.0.1:1/v1", undefined)).models).toEqual(["m"]);
});
