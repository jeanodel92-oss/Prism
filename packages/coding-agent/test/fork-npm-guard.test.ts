import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type * as UndiciModule from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionUIContext, InlineExtension } from "../src/core/extensions/types.ts";
import { getLanguage, setLanguage } from "../src/fork/i18n/index.ts";
import {
	checkInstalls,
	checkPackage,
	lockedNames,
	npmInstallRefusal,
	parseInstalls,
	popularLookalike,
	type RegistryFetch,
	resolveRegistry,
} from "../src/fork/npm-guard.ts";
import { POPULAR_NPM_PACKAGES } from "../src/fork/npm-popular.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

// The guard's requests go through undici with the DNS guard; a stubbed global fetch still stands in for the network.
vi.mock("undici", async (original) => {
	const undici = await original<typeof UndiciModule>();
	return {
		...undici,
		fetch: ((url, options) =>
			vi.isMockFunction(globalThis.fetch)
				? globalThis.fetch(url as string, options as RequestInit)
				: undici.fetch(url, options)) as typeof undici.fetch,
	};
});

const NOW = Date.UTC(2026, 9, 28);
const oldMetadata = { time: { created: "2015-01-01T00:00:00Z" } };
const publicRegistry = resolveRegistry("react");
const response = (data: unknown, status = 200) =>
	new Response(data === undefined ? null : JSON.stringify(data), { status });
const healthyFetch: RegistryFetch = async (url) =>
	response(url.includes("api.npmjs.org") ? { downloads: 100_000 } : oldMetadata);
const names = (command: string) => parseInstalls(command).map((install) => install.name);

describe("npm guard: direct install parsing", () => {
	it.each([
		["npm install react", ["react"]],
		["npm i -D react@19.0.0 @types/react@latest", ["react", "@types/react"]],
		["npm add --save-dev typescript", ["typescript"]],
		["npm -g install eslint", ["eslint"]],
		["pnpm add -D typescript@^5 @scope/pkg@tag", ["typescript", "@scope/pkg"]],
		["yarn add --dev 'react@^19'", ["react"]],
		["bun add -g tsx", ["tsx"]],
		["bun install --save-dev vite", ["vite"]],
		["npm i alias@npm:react@^19 @mine/alias@npm:@types/node@latest", ["react", "@types/node"]],
		[
			"true && npm i react; pnpm add vue | cat\nyarn add svelte || bun add zod & npm add vite",
			["react", "vue", "svelte", "zod", "vite"],
		],
		["npm i --cache /tmp/cache --tag latest react", ["react"]],
		["env FOO=x /usr/bin/npm i react", ["react"]],
		// review, point 4: every alias that installs named packages, and the usual prefixes.
		["pnpm install react", ["react"]],
		["pnpm i -D react", ["react"]],
		["bun i react", ["react"]],
		["npm in react && npm isntall vue && npm instal svelte", ["react", "vue", "svelte"]],
		["npm it react", ["react"]],
		["npm install-test react", ["react"]],
		["sudo npm i -g react", ["react"]],
		["time npm i react", ["react"]],
		["command npm i react", ["react"]],
		["nohup pnpm add react", ["react"]],
		["corepack pnpm add react", ["react"]],
		["corepack yarn add react", ["react"]],
		["nice -n 5 npm i react", ["react"]],
	])("parses %s", (command, expected) => expect(names(command)).toEqual(expected));

	it.each([
		"npm install",
		"npm ci",
		"yarn",
		"yarn install",
		"pnpm install",
		"bun install",
		"npm run install react",
		"pip install react",
		"npx react",
		"pnpm dlx react",
		"npm uninstall react",
		"npm i ./x ../x /absolute file:thing link:thing workspace:* https://example.test/x.tgz git+https://example.test/repo github:user/repo user/repo archive.tgz",
		"npm i react@file:../react other@workspace:* third@https://example.test/a.tgz",
	])("skips %s", (command) => expect(names(command)).toEqual([]));

	it("preserves directory changes and marks unsupported command configuration", () => {
		expect(parseInstalls("cd child && npm i react", "/project")).toEqual([
			{ name: "react", cwd: "/project/child", unverifiable: false },
		]);
		for (const command of [
			"npm i --registry=https://private.test react",
			"npm --prefix elsewhere i react",
			"NPM_CONFIG_REGISTRY=x npm i react",
			"cd $TARGET && npm i react",
			"sudo -u other npm i react",
		])
			expect(parseInstalls(command)[0]?.unverifiable).toBe(true);
		expect(parseInstalls("sudo npm i react")[0]?.unverifiable).toBe(false);
	});
});

describe("npm guard: registries, locks and privacy", () => {
	let root: string;
	let home: string;
	let cwd: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-npm-guard-"));
		home = join(root, "home");
		cwd = join(root, "project");
		mkdirSync(home);
		mkdirSync(cwd);
		writeFileSync(join(cwd, "package.json"), "{}");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	const check = (command: string, fetch: RegistryFetch = healthyFetch) =>
		checkInstalls(command, { cwd, home, fetch, now: () => NOW });

	it("uses scoped registry before general registry and project keys before user keys", () => {
		expect(
			resolveRegistry(
				"@corp/pkg",
				"registry=https://project.test/\n",
				"@corp:registry=https://corp.test/npm/\nregistry=https://user.test/",
			),
		).toEqual({ url: "https://corp.test/npm/", public: false });
		expect(resolveRegistry("pkg", "registry=https://project.test", "registry=https://user.test")).toEqual({
			url: "https://project.test/",
			public: false,
		});
		expect(resolveRegistry("pkg", "", "registry=https://user.test")).toEqual({
			url: "https://user.test/",
			public: false,
		});
		expect(publicRegistry).toEqual({ url: "https://registry.npmjs.org/", public: true });
	});

	it.each(["@corp:registry=https://private.test/npm/", "registry=https://private.test/npm/"])(
		"never leaks private names with %s",
		async (npmrc) => {
			writeFileSync(join(cwd, ".npmrc"), npmrc);
			const fetch = vi.fn(healthyFetch);
			await check("npm i @corp/secret", fetch);
			expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://private.test/npm/@corp%2Fsecret"]);
			expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "error" });
		},
	);

	it("reads the injected user home, ignores auth and does not attach credentials", async () => {
		writeFileSync(join(home, ".npmrc"), "registry=https://private.test/\n//private.test/:_authToken=DO_NOT_SEND\n");
		const fetch = vi.fn(healthyFetch);
		await check("yarn add internal-package", fetch);
		expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://private.test/internal-package"]);
		expect(JSON.stringify(fetch.mock.calls)).not.toContain("DO_NOT_SEND");
	});

	it.each([
		`registry=\${PRIVATE_REGISTRY}`,
		"registry[]=https://private.test/",
		"userconfig=/private/.npmrc",
		"registry=not-a-url",
		"[registry]",
		"registry=https://user:secret@private.test/",
		"registry=https://private.test/?token=secret",
	])("fails closed without a request for %s", async (npmrc) => {
		writeFileSync(join(cwd, ".npmrc"), npmrc);
		const fetch = vi.fn(healthyFetch);
		const result = await check("npm i internal-package", fetch);
		expect(result[0].reasons.join(" ")).toContain("could not be verified");
		expect(fetch).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain("secret");
	});

	it("never follows a private registry redirect or falls back after an HTTP error", async () => {
		writeFileSync(join(cwd, ".npmrc"), "registry=https://private.test/");
		const fetch = vi.fn<RegistryFetch>(async () => response(undefined, 302));
		expect((await check("npm i confidential", fetch))[0].reasons.join(" ")).toContain("could not be verified");
		expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://private.test/confidential"]);
	});

	it("skips locked packages from all four dependency fields, including scoped names", async () => {
		writeFileSync(
			join(cwd, "package.json"),
			JSON.stringify({
				dependencies: { react: "*" },
				devDependencies: { vite: "*" },
				optionalDependencies: { sharp: "*" },
				peerDependencies: { vue: "*" },
			}),
		);
		writeFileSync(
			join(cwd, "package-lock.json"),
			JSON.stringify({
				packages: {
					"node_modules/react": {},
					"node_modules/vite": {},
					"node_modules/sharp": {},
					"node_modules/vue": {},
					"node_modules/@corp/locked": {},
					"node_modules/zod": {},
				},
			}),
		);
		expect([...lockedNames(cwd)]).toEqual(["react", "vite", "sharp", "vue", "@corp/locked", "zod"]);
		const fetch = vi.fn(healthyFetch);
		expect(await check("npm i react vite sharp vue @corp/locked zod alias@npm:react@19", fetch)).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("uses the correct project registry after cd and from a child directory", async () => {
		mkdirSync(join(cwd, "child"));
		writeFileSync(join(cwd, "child", "package.json"), "{}");
		writeFileSync(join(cwd, "child", ".npmrc"), "registry=https://child.test/");
		const fetch = vi.fn(healthyFetch);
		await check("cd child && bun add confidential", fetch);
		expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://child.test/confidential"]);
		mkdirSync(join(cwd, "nested"));
		writeFileSync(join(cwd, ".npmrc"), "registry=https://parent.test/");
		fetch.mockClear();
		await checkInstalls("npm i confidential", { cwd: join(cwd, "nested"), home, fetch, now: () => NOW });
		expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://parent.test/confidential"]);
	});

	// fork: `mkdir p && cd p && npm install x` was refused as unreadable configuration,
	// since the folder is made by the command; it has the configuration of the folders above it.
	it("checks an install in a folder the command makes first, with the registry of the folders above", async () => {
		writeFileSync(join(cwd, ".npmrc"), "registry=https://project.test/");
		const fetch = vi.fn(healthyFetch);
		const results = await check("mkdir made && cd made && npm init -y && npm install is-number@7.0.0", fetch);
		expect(results.flatMap(({ reasons }) => reasons).join(" ")).not.toContain("could not be read");
		expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://project.test/is-number"]);
		writeFileSync(join(cwd, "file"), "");
		const file = await check("cd file && npm install is-number", fetch);
		expect(file[0].reasons.join(" ")).toContain("could not be read or parsed");
	});

	it("does not query when the command overrides registry configuration or config cannot be read", async () => {
		const fetch = vi.fn(healthyFetch);
		for (const command of [
			"npm i --registry https://private.test confidential",
			"pnpm --dir /other add confidential",
		])
			expect((await check(command, fetch))[0].reasons.join(" ")).toContain("could not be verified");
		mkdirSync(join(cwd, ".npmrc"));
		expect((await check("npm i confidential", fetch))[0].reasons.join(" ")).toContain("could not be verified");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("queries only the registry an npm_config_registry variable selects", async () => {
		const fetch = vi.fn(healthyFetch);
		const result = await checkInstalls("npm i confidential", {
			cwd,
			home,
			fetch,
			now: () => NOW,
			env: { NPM_CONFIG_REGISTRY: "https://private.test/" },
		});
		expect(result[0].reasons).toEqual([]);
		expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://private.test/confidential"]);
	});

	it.each([
		[".yarnrc.yml", 'npmScopes:\n  corp:\n    npmRegistryServer: "https://private.test"\n'],
		["bunfig.toml", '[install.scopes]\ncorp = "https://private.test/"\n'],
	])("does not guess the registry when %s configures one", async (file, text) => {
		writeFileSync(join(cwd, file), text);
		const fetch = vi.fn(healthyFetch);
		expect((await check("yarn add @corp/secret", fetch))[0].reasons.join(" ")).toContain("could not be verified");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("follows a scoped registry variable", async () => {
		const fetch = vi.fn(healthyFetch);
		const result = await checkInstalls("npm i @corp/secret", {
			cwd,
			home,
			fetch,
			now: () => NOW,
			env: {
				"npm_config_@corp:registry": "https://private.test/",
				npm_config_registry: "https://registry.npmjs.org/",
			},
		});
		expect(result[0].reasons).toEqual([]);
		expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://private.test/@corp%2Fsecret"]);
	});

	it("reads the npmrc files npm_config variables point to, as npm does under npm run", async () => {
		writeFileSync(join(root, "user-npmrc"), "@corp:registry=https://user-config.test/\n");
		writeFileSync(join(root, "global-npmrc"), "registry=https://global-config.test/\n");
		const fetch = vi.fn(healthyFetch);
		const run = (command: string, env: NodeJS.ProcessEnv) =>
			checkInstalls(command, { cwd, home, fetch, now: () => NOW, env });
		await run("npm i @corp/secret", { NPM_CONFIG_USERCONFIG: join(root, "user-npmrc") });
		await run("npm i confidential", { npm_config_globalconfig: join(root, "global-npmrc") });
		mkdirSync(join(root, "prefix", "etc"), { recursive: true });
		writeFileSync(join(root, "prefix", "etc", "npmrc"), "registry=https://prefix-config.test/\n");
		await run("npm i confidential", { npm_config_prefix: join(root, "prefix") });
		expect(fetch.mock.calls.map(([url]) => url)).toEqual([
			"https://user-config.test/@corp%2Fsecret",
			"https://global-config.test/confidential",
			"https://prefix-config.test/confidential",
		]);
	});

	it.each([
		["pnpm-lock.yaml", "packages:\n\n  '@corp/secret@1.0.0':\n    resolution: {}\n"],
		["yarn.lock", '"@corp/secret@^1.0.0":\n  version "1.0.0"\n'],
		["bun.lock", '{ "packages": { "@corp/secret": ["@corp/secret@1.0.0", ""] } }'],
	])("skips a name locked in %s", async (file, text) => {
		writeFileSync(join(cwd, file), text);
		const fetch = vi.fn(healthyFetch);
		expect(await check("pnpm add @corp/secret", fetch)).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("checks a workspace install against the usual registry", async () => {
		const fetch = vi.fn(healthyFetch);
		expect(parseInstalls("npm i -w packages/app react")[0]?.unverifiable).toBe(false);
		expect(parseInstalls("pnpm add --filter app react")[0]?.unverifiable).toBe(false);
		expect((await check("npm i --workspace packages/app react", fetch))[0].reasons).toEqual([]);
	});

	it("does not guess the registry after a possibly failed directory change", async () => {
		const fetch = vi.fn(healthyFetch);
		for (const command of [
			"cd missing && npm i confidential",
			"cd missing; npm i confidential",
			"cd missing || npm i confidential",
			"cd missing | npm i confidential",
		])
			expect((await check(command, fetch))[0].reasons.join(" ")).toContain("could not be verified");
		expect(fetch).not.toHaveBeenCalled();
	});

	// review, point 1: npm reads the .npmrc of a workspace root or of a parent folder too.
	it.each([
		["a workspace root", { workspaces: ["project"] }],
		["a parent folder", undefined],
	])("never sends a scoped name to the public registry when %s configures its registry", async (_case, manifest) => {
		writeFileSync(join(root, ".npmrc"), "@corp:registry=https://npm.corp.example/\n");
		if (manifest) writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
		const fetch = vi.fn(healthyFetch);
		const [result] = await check("npm i @corp/secret-tool", fetch);
		expect(fetch).not.toHaveBeenCalled();
		expect(result.reasons.join(" ")).toContain("could not be verified");
	});
});

describe("npm guard: heuristics and bounded requests", () => {
	afterEach(() => vi.useRealTimers());
	const check = (name: string, fetch: RegistryFetch = healthyFetch) =>
		checkPackage(name, publicRegistry, { fetch, now: () => NOW });
	it("has a modest reference list without duplicates", () => {
		expect(new Set(POPULAR_NPM_PACKAGES).size).toBe(POPULAR_NPM_PACKAGES.length);
		expect(POPULAR_NPM_PACKAGES.length).toBeGreaterThanOrEqual(100);
		expect(POPULAR_NPM_PACKAGES.length).toBeLessThanOrEqual(200);
	});
	it.each(["react", "lodash", "typescript", "@types/node"])(
		"does not alert for old popular exact name %s",
		async (name) => {
			expect((await check(name)).reasons).toEqual([]);
		},
	);
	it.each(["reaxt", "recat", "reactt", "tyepscritp", "exprezzs", "react_dom", "react.dom", "@fake/react", "core"])(
		"recognizes a popular lookalike %s",
		(name) => {
			expect(popularLookalike(name)).toBeDefined();
		},
	);
	it("alerts for a typo and 404", async () => {
		const result = await check("recat", async () => response(undefined, 404));
		expect(result.reasons).toEqual([
			"Name resembles popular package react.",
			"Package does not exist in the configured registry (HTTP 404).",
		]);
	});
	it("alerts for creation 5 days ago and 200 downloads", async () => {
		const fetch: RegistryFetch = async (url) =>
			response(
				url.includes("api.npmjs.org")
					? { downloads: 200 }
					: { time: { created: new Date(NOW - 5 * 86_400_000).toISOString() } },
			);
		const result = await check("unique-new-project", fetch);
		expect(result.reasons).toEqual([
			"Package was created less than 30 days ago.",
			"Only 200 downloads last week (fewer than 1,000).",
		]);
	});
	it("accepts the exact 30-day and 1,000-download boundaries", async () => {
		const fetch: RegistryFetch = async (url) =>
			response(
				url.includes("api.npmjs.org")
					? { downloads: 1_000 }
					: { time: { created: new Date(NOW - 30 * 86_400_000).toISOString() } },
			);
		expect((await check("unique-new-project", fetch)).reasons).toEqual([]);
	});
	it.each([
		async () => {
			throw new Error("secret upstream details");
		},
		async () => response(undefined, 500),
		async () => new Response("not json"),
		async () => response({}),
		async () => response({ time: { created: "invalid" } }),
		async () => response({ time: { created: new Date(NOW + 10_000).toISOString() } }),
	])("marks metadata failure as unverifiable", async (fetch) => {
		const result = await check("unique-new-project", fetch);
		expect(result.reasons.join(" ")).toContain("could not be verified");
		expect(JSON.stringify(result)).not.toContain("secret upstream details");
	});
	it("omits a failed downloads check but includes the missing statistic in details", async () => {
		const result = await check("recat", async (url) =>
			url.includes("api.npmjs.org") ? response(undefined, 503) : response(oldMetadata),
		);
		expect(result.reasons).toEqual(["Name resembles popular package react."]);
		expect(result.details).toEqual(["Weekly downloads unavailable; the download check was omitted."]);
	});
	it("bounds fetch and response-body timeouts at 3 seconds even if fetch ignores abort", async () => {
		vi.useFakeTimers();
		for (const fetch of [async () => new Promise<never>(() => {}), async () => new Response(new ReadableStream())]) {
			const pending = check("react", fetch);
			await vi.advanceTimersByTimeAsync(3_000);
			expect((await pending).reasons.join(" ")).toContain("could not be verified");
		}
	});
	it("caps the whole command at 6 seconds, including queued packages", async () => {
		vi.useFakeTimers();
		const fetch = vi.fn<RegistryFetch>(async () => new Promise<never>(() => {}));
		const pending = checkInstalls("npm i one two three four five six seven eight nine", {
			cwd: "/fake",
			home: "/fake-home",
			read: () => undefined,
			fetch,
			now: () => NOW,
		});
		await vi.advanceTimersByTimeAsync(6_000);
		expect(await pending).toHaveLength(9);
		expect(
			(await pending).every((result) => result.reasons.some((reason) => reason.includes("could not be verified"))),
		).toBe(true);
		expect(fetch).toHaveBeenCalledTimes(8);
	});
	it("measures latency with 50ms fake requests and concurrent package checks", async () => {
		const fetch: RegistryFetch = async (url) => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			return healthyFetch(url, { signal: new AbortController().signal, redirect: "error" });
		};
		const start = performance.now();
		const results = await checkInstalls("npm i react lodash typescript", {
			cwd: "/fake",
			home: "/fake-home",
			read: () => undefined,
			fetch,
			now: () => NOW,
		});
		const elapsed = performance.now() - start;
		console.log(`npm guard latency: 3 packages, 6 fake requests at 50ms each: ${elapsed.toFixed(1)}ms`);
		expect(results.every((result) => result.reasons.length === 0)).toBe(true);
		expect(elapsed).toBeGreaterThanOrEqual(95);
		expect(elapsed).toBeLessThan(1_000);
	});
});

describe("npm guard: permission extension", () => {
	let root: string;
	const harnesses: Harness[] = [];
	const savedLanguage = getLanguage();
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-npm-gate-"));
		vi.stubEnv("HOME", root);
		vi.stubEnv(ENV_AGENT_DIR, root);
		writeFileSync(
			join(root, "settings.json"),
			JSON.stringify({ sandbox: { modes: { broad: false, ask: false, safe: false } } }),
		);
		writeFileSync(join(root, "permissions.json"), JSON.stringify({ mode: "broad" }));
		setLanguage("en");
		vi.stubGlobal(
			"fetch",
			vi.fn<RegistryFetch>(async () => response(undefined, 404)),
		);
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		setLanguage(savedLanguage);
		rmSync(root, { recursive: true, force: true });
	});
	async function start(answer: "confirm" | "refuse" | "none", withUI = true) {
		const ran: string[] = [];
		const tools: InlineExtension = {
			name: "fake-shells",
			factory: (pi) => {
				for (const name of ["bash", "background"])
					pi.registerTool({
						name,
						label: name,
						description: "Fake shell: never installs or executes anything.",
						parameters: Type.Object({ command: Type.String(), action: Type.Optional(Type.String()) }),
						execute: async (_id, params) => {
							ran.push(params.command);
							return { content: [{ type: "text", text: "fake install ran" }], details: {} };
						},
					});
			},
		};
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }, tools],
		});
		harnesses.push(harness);
		const selects: { title: string; options: string[] }[] = [];
		await harness.session.bindExtensions(
			withUI
				? {
						uiContext: createTestUiContext({
							select: async (title, options) => {
								selects.push({ title, options });
								return answer === "none" ? undefined : options[answer === "confirm" ? 0 : 1];
							},
						}),
					}
				: {},
		);
		return { harness, selects, ran };
	}
	async function call(harness: Harness, command: string, tool = "bash", action = "run") {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall(tool, { command, ...(tool === "background" ? { action } : {}) }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
	}
	it.each(["bash", "background"])("asks in broad and blocks a refused %s install", async (tool) => {
		const { harness, selects, ran } = await start("refuse");
		await call(harness, "npm i recat missing-in-registry", tool);
		expect(selects).toHaveLength(1);
		expect(selects[0].options).toEqual(["Confirm npm install once (this call only)", "Refuse npm install"]);
		expect(selects[0].title).toContain("recat:");
		expect(selects[0].title).toContain("missing-in-registry:");
		expect(selects[0].title).toContain("heuristics, not proof of malice");
		expect(selects[0].title).toContain("sandbox remains the real boundary");
		expect(ran).toEqual([]);
		expect(JSON.stringify(getToolResult(harness, tool).content)).toContain("npm install blocked");
	});
	it("confirmation proceeds, lasts only for this call and is never remembered", async () => {
		const { harness, selects, ran } = await start("confirm");
		await call(harness, "npm i recat");
		await call(harness, "npm i recat");
		expect(selects).toHaveLength(2);
		expect(ran).toEqual(["npm i recat", "npm i recat"]);
	});
	it.each([false, true])("blocks when nobody can confirm (UI=%s)", async (withUI) => {
		const { harness, ran } = await start("none", withUI);
		await call(harness, "npm i recat");
		expect(ran).toEqual([]);
		expect(getToolResult(harness, "bash").isError).toBe(true);
	});
	it("does not ask in broad when there is no alert", async () => {
		vi.stubGlobal("fetch", vi.fn(healthyFetch));
		const { harness, selects, ran } = await start("refuse");
		await call(harness, "npm i react");
		expect(selects).toEqual([]);
		expect(ran).toHaveLength(1);
	});
	it("skips non-run background calls, bare installs and other ecosystems without a lookup", async () => {
		const { harness, selects } = await start("refuse");
		await call(harness, "npm i recat", "background", "status");
		await call(harness, "npm install");
		await call(harness, "pip install recat");
		expect(selects).toEqual([]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
	it("continues through the normal gate after confirmation in ask mode", async () => {
		writeFileSync(join(root, "permissions.json"), JSON.stringify({ mode: "ask" }));
		const { harness, selects, ran } = await start("confirm");
		await call(harness, "npm i recat");
		expect(selects.map((select) => select.title.split("\n")[0])).toEqual([
			"Review suspicious npm packages before installing?",
			"Allow this action? bash",
		]);
		expect(ran).toHaveLength(1);
	});
	it("preserves unrestricted mode: no lookups and no questions", async () => {
		writeFileSync(
			join(root, "permissions.json"),
			JSON.stringify({ mode: "unrestricted", unrestrictedAccepted: true }),
		);
		const { harness, selects, ran } = await start("refuse");
		await call(harness, "npm i recat");
		expect(selects).toEqual([]);
		expect(ran).toHaveLength(1);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
	it("does not bypass the guard through a broad allow rule", async () => {
		writeFileSync(join(root, "permissions.json"), JSON.stringify({ mode: "broad", allow: ["bash(*)"] }));
		const { harness, selects, ran } = await start("refuse");
		await call(harness, "npm i recat");
		expect(selects).toHaveLength(1);
		expect(ran).toEqual([]);
	});
	it("blocks an alert in a scheduled run even if a UI is supplied", async () => {
		const { harness, selects, ran } = await start("confirm");
		harness.session.extensionRunner.setFlagValue("scheduled", "missing-test-task");
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
		await call(harness, "npm i recat");
		expect(selects).toEqual([]);
		expect(ran).toEqual([]);
		expect(JSON.stringify(getToolResult(harness, "bash").content)).toContain("npm install blocked");
	});
	it("translates the guard question, reasons and choices without changing names", async () => {
		setLanguage("fr");
		const { harness, selects, ran } = await start("confirm");
		await call(harness, "npm i recat");
		expect(selects[0].title).toContain("Vérifier les paquets npm suspects");
		expect(selects[0].title).toContain("recat:");
		expect(selects[0].title).toContain("Le nom ressemble");
		expect(selects[0].options[0]).toContain("cet appel seulement");
		expect(ran).toHaveLength(1);
	});
	it("tells the model in English when the French interface refuses", async () => {
		setLanguage("fr");
		const { harness, selects, ran } = await start("refuse");
		await call(harness, "npm i recat");
		expect(selects[0].title).toContain("Le nom ressemble");
		expect(ran).toEqual([]);
		const reason = JSON.stringify(getToolResult(harness, "bash").content);
		expect(reason).toContain("npm install blocked");
		expect(reason).toContain("Name resembles popular package react.");
		expect(reason).not.toContain("Le nom");
	});
	it("shows unavailable downloads in the alert details", async () => {
		const ui = { select: vi.fn<ExtensionUIContext["select"]>(async () => undefined) };
		await npmInstallRefusal("npm i recat", {
			cwd: root,
			home: root,
			fetch: async (url) => (url.includes("api.npmjs.org") ? response(undefined, 500) : response(oldMetadata)),
			now: () => NOW,
			ui,
		});
		expect(ui.select.mock.calls[0]?.[0]).toContain("Weekly downloads unavailable");
	});
});

// review, point 1: the registry a project names is a destination of the network policy, not an
// authorization. These tests run a fake registry on this machine and count what reaches it.
describe("npm guard: network policy", () => {
	let root: string;
	let server: Server;
	let port: number;
	const requests: string[] = [];
	const harnesses: Harness[] = [];
	const settings = (network: Record<string, unknown>) =>
		writeFileSync(
			join(root, "settings.json"),
			JSON.stringify({ sandbox: { modes: { broad: false, ask: false, safe: false }, network } }),
		);
	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "prism-npm-net-"));
		vi.stubEnv("HOME", root);
		vi.stubEnv(ENV_AGENT_DIR, root);
		settings({});
		writeFileSync(join(root, "permissions.json"), JSON.stringify({ mode: "broad" }));
		setLanguage("en");
		requests.length = 0;
		server = createServer((request, reply) => {
			requests.push(request.url ?? "");
			reply.setHeader("content-type", "application/json");
			reply.end(JSON.stringify(oldMetadata));
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		port = (server.address() as AddressInfo).port;
	});
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		setLanguage("en");
		await new Promise((done) => server.close(done));
		rmSync(root, { recursive: true, force: true });
	});
	async function install(command: string, npmrc?: string) {
		const ran: string[] = [];
		const selects: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				{ name: "permissions", factory: permissionsExtension },
				{
					name: "fake-shell",
					factory: (pi) =>
						pi.registerTool({
							name: "bash",
							label: "bash",
							description: "Fake shell: never installs or executes anything.",
							parameters: Type.Object({ command: Type.String() }),
							execute: async (_id, params) => {
								ran.push(params.command);
								return { content: [{ type: "text", text: "fake install ran" }], details: {} };
							},
						}),
				},
			],
		});
		harnesses.push(harness);
		if (npmrc !== undefined) writeFileSync(join(harness.tempDir, ".npmrc"), npmrc);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title, options) => {
					selects.push(title);
					return options[1];
				},
			}),
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		return { ran, selects };
	}
	const local = () => `@corp:registry=http://127.0.0.1:${port}/\n`;

	it("does not contact a project registry the network permissions do not allow", async () => {
		const { ran, selects } = await install("npm i @corp/tool", local());
		expect(requests).toEqual([]);
		expect(ran).toEqual([]);
		expect(selects[0]).toContain(`network permissions do not allow localhost:${port}; it was not contacted`);
	});
	it("says in French which destination was not contacted", async () => {
		setLanguage("fr");
		const { selects } = await install("npm i @corp/tool", local());
		expect(selects[0]).toContain(`les permissions réseau de Prism n'autorisent pas localhost:${port}`);
	});
	it("does not contact a port of this machine other than the one allowed", async () => {
		settings({ allow: [`localhost:${port + 1}`] });
		await install("npm i @corp/tool", local());
		expect(requests).toEqual([]);
	});
	it("does not contact a blocked host even when it is also allowed", async () => {
		settings({ allow: [`localhost:${port}`], deny: ["localhost"] });
		await install("npm i @corp/tool", local());
		expect(requests).toEqual([]);
	});
	it("checks the package in a registry the user allowed", async () => {
		settings({ allow: [`localhost:${port}`] });
		const { ran, selects } = await install("npm i @corp/tool", local());
		expect(requests).toEqual(["/@corp%2Ftool"]);
		expect(selects).toEqual([]);
		expect(ran).toEqual(["npm i @corp/tool"]);
	});
	it("stops contacting a registry once its permission is taken back", async () => {
		settings({ allow: [`localhost:${port}`] });
		await install("npm i @corp/tool", local());
		settings({});
		await install("npm i @corp/tool", local());
		expect(requests).toEqual(["/@corp%2Ftool"]);
	});
	it("does not query the public registry when the user blocked it", async () => {
		const fetch = vi.fn<RegistryFetch>(async () => response(oldMetadata));
		vi.stubGlobal("fetch", fetch);
		settings({ deny: ["registry.npmjs.org", "api.npmjs.org"] });
		const { selects } = await install("npm i recat");
		expect(fetch).not.toHaveBeenCalled();
		expect(selects[0]).toContain("network permissions do not allow registry.npmjs.org");
	});
});
