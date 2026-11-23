// fork (audit PB-22): `prism auth login <provider>` and `prism auth logout <provider>`, sign-in and API key from the
// shell without a session. Fake providers only, credentials in a throwaway agent dir: no network, no keyring.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseAuthCommand } from "../src/cli/auth-command.ts";
import { APP_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage, FileAuthStorageBackend } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";
import { type AuthTerminal, runAuthLogin, runAuthLogout } from "../src/fork/auth-login-cli.ts";

const VERIFY_URL = "https://auth.example.test/device";
const SIGN_IN_URL = "https://auth.example.test/authorize?state=abc";

function model(provider: string): Model<"openai-completions"> {
	return {
		id: "fake-model",
		name: "Fake model",
		api: "openai-completions",
		provider,
		baseUrl: "https://api.example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function oauthCredential(access: string): OAuthCredential {
	return { type: "oauth", access, refresh: "refresh", expires: Date.now() + 3_600_000 };
}

/** A provider with an account sign-in (a browser method and a device code method) and an API key. */
function fakeProvider(id: string, name: string, methods: "browser-and-device" | "browser-only"): Provider {
	const providerModel = model(id);
	return {
		id,
		name,
		auth: {
			apiKey: {
				name: `${name} API key`,
				login: async (interaction) => ({
					type: "api_key",
					key: await interaction.prompt({ type: "secret", message: `Enter ${name} API key` }),
				}),
				check: async ({ credential }) => (credential ? { type: "api_key", source: "stored" } : undefined),
				resolve: async ({ credential }) =>
					credential ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
			},
			oauth: {
				name: `${name} account`,
				async login(interaction) {
					const method =
						methods === "browser-only"
							? "browser"
							: await interaction.prompt({
									type: "select",
									message: "Select login method:",
									options: [
										{ id: "browser", label: "Browser login (default)" },
										{ id: "device", label: "Device code login (headless)" },
									],
								});
					if (method === "device") {
						interaction.notify({ type: "device_code", userCode: "WXYZ-1234", verificationUri: VERIFY_URL });
						return oauthCredential("device-token");
					}
					interaction.notify({ type: "auth_url", url: SIGN_IN_URL });
					const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
					return oauthCredential(`browser-${code}`);
				},
				refresh: async (credential) => credential,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		getModels: () => [providerModel],
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

class ScriptedTerminal implements AuthTerminal {
	interactive = true;
	out: string[] = [];
	err: string[] = [];
	opened: string[] = [];
	questions: string[] = [];
	secrets: string[] = [];
	answers: string[];

	constructor(answers: string[] = []) {
		this.answers = answers;
	}

	write(line: string): void {
		this.out.push(line);
	}
	error(line: string): void {
		this.err.push(line);
	}
	async question(message: string): Promise<string> {
		this.questions.push(message);
		const answer = this.answers.shift();
		if (answer === undefined) throw new Error(`unexpected question: ${message}`);
		return answer;
	}
	async secret(message: string): Promise<string> {
		this.secrets.push(message);
		const answer = this.answers.shift();
		if (answer === undefined) throw new Error(`unexpected secret prompt: ${message}`);
		return answer;
	}
	openUrl(url: string): void {
		this.opened.push(url);
	}
}

describe("fork: prism auth login / logout (PB-22)", () => {
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	let agentDir: string;
	let authPath: string;
	let runtime: ModelRuntime;

	beforeAll(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-auth-login-"));
		// getAuthPath() in the success message reads the throwaway dir, never the real one.
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterAll(() => {
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	beforeEach(async () => {
		authPath = join(mkdtempSync(join(agentDir, "run-")), "auth.json");
		runtime = await ModelRuntime.create({
			// The file only: no Secret Service keyring in tests.
			credentials: AuthStorage.fromStorage(new FileAuthStorageBackend(authPath)),
			modelsPath: null,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		runtime.registerNativeProvider(fakeProvider("fake-cloud", "Fake Cloud", "browser-and-device"));
		runtime.registerNativeProvider(fakeProvider("fake-browser", "Fake Browser", "browser-only"));
	});

	afterEach(() => {
		rmSync(join(authPath, ".."), { recursive: true, force: true });
	});

	const storedAuth = (): Record<string, unknown> => JSON.parse(readFileSync(authPath, "utf-8"));

	const login = (args: string[], terminal: ScriptedTerminal) =>
		runAuthLogin(args, {
			modelRuntime: runtime,
			terminal,
			signal: new AbortController().signal,
			getDeviceId: () => "device-id",
		});

	it("saves the API key given on the command line in the agent dir, without a terminal", async () => {
		const terminal = new ScriptedTerminal();
		terminal.interactive = false;

		expect(await login(["fake-cloud", "--api-key", "test-key-123"], terminal)).toBe(0);

		expect(storedAuth()["fake-cloud"]).toEqual({ type: "api_key", key: "test-key-123" });
		expect(terminal.secrets).toEqual([]);
		expect(terminal.err).toEqual([]);
		expect(terminal.out[0]).toBe(`Saved API key for Fake Cloud. Credentials saved to ${join(agentDir, "auth.json")}`);
		// The key itself is never printed.
		expect(terminal.out.join("\n")).not.toContain("test-key-123");
	});

	it("asks for the key without echo when --api-key has no value, and matches the provider by name", async () => {
		const terminal = new ScriptedTerminal(["typed-key"]);

		expect(await login(["--api-key", "fake cloud"], terminal)).toBe(0);

		expect(terminal.secrets).toEqual(["Enter Fake Cloud API key: "]);
		expect(storedAuth()["fake-cloud"]).toEqual({ type: "api_key", key: "typed-key" });
	});

	it("logout removes the stored key; a second logout succeeds with nothing to remove", async () => {
		await login(["fake-cloud", "--api-key=test-key-123"], new ScriptedTerminal());
		expect(storedAuth()["fake-cloud"]).toBeDefined();

		const terminal = new ScriptedTerminal();
		expect(await runAuthLogout(["fake-cloud"], { modelRuntime: runtime, terminal })).toBe(0);
		expect(storedAuth()["fake-cloud"]).toBeUndefined();
		expect(terminal.out).toEqual([
			"Removed stored API key for Fake Cloud. Environment variables and models.json config are unchanged.",
		]);

		const again = new ScriptedTerminal();
		expect(await runAuthLogout(["fake-cloud"], { modelRuntime: runtime, terminal: again })).toBe(0);
		expect(again.out[0]).toMatch(/^No stored credentials for Fake Cloud\./);
	});

	it("rejects an unknown provider at login and logout, listing what exists", async () => {
		const terminal = new ScriptedTerminal();
		expect(await login(["no-such-provider", "--api-key", "k"], terminal)).toBe(1);
		expect(terminal.err[0]).toBe('Unknown provider "no-such-provider".');
		expect(terminal.err[1]).toMatch(/^Providers: .*fake-browser, fake-cloud/);

		const logout = new ScriptedTerminal();
		expect(await runAuthLogout(["no-such-provider"], { modelRuntime: runtime, terminal: logout })).toBe(1);
		expect(logout.err).toEqual(['Unknown provider "no-such-provider".', "Stored credentials: none"]);
	});

	it("account sign-in opens the browser by default and points to --no-browser", async () => {
		const terminal = new ScriptedTerminal(["code42"]);

		expect(await login(["fake-cloud"], terminal)).toBe(0);

		expect(terminal.opened).toEqual([SIGN_IN_URL]);
		expect(terminal.out).toContain(`Open this URL to sign in:\n  ${SIGN_IN_URL}`);
		expect(terminal.out).toContain(
			`To use "Device code login (headless)" instead, run "${APP_NAME} auth login fake-cloud --no-browser"`,
		);
		expect(storedAuth()["fake-cloud"]).toMatchObject({ type: "oauth", access: "browser-code42" });
	});

	it("--no-browser takes the other method and prints its URL and code without opening a browser", async () => {
		const terminal = new ScriptedTerminal();

		expect(await login(["fake-cloud", "--no-browser"], terminal)).toBe(0);

		expect(terminal.opened).toEqual([]);
		expect(terminal.out).toContain(`Open ${VERIFY_URL} and enter code: WXYZ-1234`);
		expect(storedAuth()["fake-cloud"]).toMatchObject({ type: "oauth", access: "device-token" });
	});

	it("--no-browser with only a browser method prints the URL and takes the pasted code", async () => {
		const terminal = new ScriptedTerminal(["pasted"]);

		expect(await login(["fake-browser", "--no-browser"], terminal)).toBe(0);

		expect(terminal.opened).toEqual([]);
		expect(terminal.out).toContain(`Open this URL to sign in:\n  ${SIGN_IN_URL}`);
		expect(terminal.questions).toEqual(["Paste the code: "]);
		expect(storedAuth()["fake-browser"]).toMatchObject({ type: "oauth", access: "browser-pasted" });
	});

	it("refuses account sign-in without a terminal and --no-browser with --api-key", async () => {
		const headless = new ScriptedTerminal();
		headless.interactive = false;
		expect(await login(["fake-cloud"], headless)).toBe(1);
		expect(headless.err[0]).toMatch(/requires an interactive terminal\.$/);
		expect(headless.err[1]).toMatch(/auth login fake-cloud --api-key <key>$/);

		const both = new ScriptedTerminal();
		expect(await login(["fake-cloud", "--api-key", "k", "--no-browser"], both)).toBe(1);
		expect(both.err[0]).toBe("--no-browser only applies to account sign-in; omit it with --api-key.");
		expect(storedAuth()["fake-cloud"]).toBeUndefined();
	});

	it("the unknown auth command error lists login and logout", () => {
		expect(() => parseAuthCommand(["auth", "nope"])).toThrow(/auth login".*auth logout".*auth print-api-key/);
	});
});
