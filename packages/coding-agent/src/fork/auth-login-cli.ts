// fork (audit PB-22, port of upstream 9b9cb30ae): `prism auth login <provider>` and `prism auth logout <provider>`
// sign in to a model provider or save its API key, and remove it, from the shell without starting a session: a
// server over SSH has no other way in. They reuse /login's own choices and messages (login-operations.ts): the same
// providers (Radius stays out, src/fork/login-menu.ts), the same warning before a Claude subscription sign-in, the
// same credential store. Providers added by extensions (Claude Code, llama.cpp) are not loaded here; /login has them.
import { createInterface } from "node:readline/promises";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { APP_NAME, getAgentDir, getAuthPath } from "../config.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "../core/http-dispatcher.ts";
import { CredentialSynchronizationError, ModelRuntime } from "../core/model-runtime.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { webUrl } from "../modes/interactive/components/login-dialog.ts";
import type { AuthSelectorProvider } from "../modes/interactive/components/oauth-selector.ts";
import { openBrowser } from "../utils/open-browser.ts";
import {
	ANTHROPIC_SUBSCRIPTION_GO,
	ANTHROPIC_SUBSCRIPTION_RISK,
	ANTHROPIC_SUBSCRIPTION_TITLE,
	isAnthropicSubscription,
} from "./anthropic-subscription.ts";
import { fill, resolveLanguage, setLanguage, t } from "./i18n/index.ts";
import {
	catalogRefreshFailure,
	LOGIN_CANCELLED,
	loginActionLabel,
	loginFailureMessage,
	loginProviderOptions,
	logoutProvider,
	logoutProviderOptions,
	matchLoginProviderOptions,
	refreshCatalogAfterLogin,
} from "./login-operations.ts";

/** Line-based terminal I/O for the two commands. Prompts reject when `signal` aborts. */
export interface AuthTerminal {
	/** Whether stdin and stdout are a terminal; prompts need one. */
	interactive: boolean;
	write(line: string): void;
	error(line: string): void;
	question(message: string, signal: AbortSignal): Promise<string>;
	/** Read a line without echoing it. */
	secret(message: string, signal: AbortSignal): Promise<string>;
	openUrl(url: string): void;
}

export interface AuthLoginOptions {
	modelRuntime: ModelRuntime;
	terminal: AuthTerminal;
	/** Aborts the login, e.g. on Ctrl+C. */
	signal: AbortSignal;
	getDeviceId: () => string;
}

export interface AuthLogoutOptions {
	modelRuntime: ModelRuntime;
	terminal: Pick<AuthTerminal, "write" | "error">;
}

const LOGIN_USAGE = `${APP_NAME} auth login <provider> [--api-key [<key>]] [--no-browser]`;
const LOGOUT_USAGE = `${APP_NAME} auth logout <provider>`;

interface LoginRequest {
	providerRef: string;
	/** Save an API key instead of signing in with an account. */
	apiKey: boolean;
	/** The key given on the command line; prompted for (without echo) when absent. */
	key?: string;
	/** Open the browser and take the browser sign-in method without asking. */
	browser: boolean;
}

/** A provider reference or URL printed as is could send its own escape sequences to the terminal. */
function printable(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?");
}

function displayUrl(value: string): string {
	return webUrl(value) ?? printable(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * `--api-key` takes the next argument as the key only once the provider is named, so `auth login openai --api-key
 * sk-…` saves that key and `auth login --api-key openai` asks for it. `--api-key=<key>` works anywhere.
 */
function parseLoginRequest(args: readonly string[]): LoginRequest | { error: string } {
	const usage = { error: fill("Usage: {0}", LOGIN_USAGE) };
	const request: LoginRequest = { providerRef: "", apiKey: false, browser: true };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--api-key") {
			request.apiKey = true;
			const next = args[index + 1];
			if (request.providerRef && next !== undefined && !next.startsWith("-")) {
				request.key = next;
				index++;
			}
		} else if (arg.startsWith("--api-key=")) {
			request.apiKey = true;
			request.key = arg.slice("--api-key=".length);
		} else if (arg === "--no-browser") request.browser = false;
		else if (arg.startsWith("-") || request.providerRef) return usage;
		else request.providerRef = arg;
	}
	if (!request.providerRef.trim()) return usage;
	if (request.key !== undefined && !request.key.trim()) return { error: t("The API key is empty.") };
	if (request.apiKey && !request.browser) {
		return { error: t("--no-browser only applies to account sign-in; omit it with --api-key.") };
	}
	return request;
}

/** The provider's account sign-in unless `--api-key` asks for a key; a provider without one takes its key. */
function selectOption(
	options: readonly AuthSelectorProvider[],
	apiKey: boolean,
): { option: AuthSelectorProvider } | { error: string } {
	const name = options[0]!.name;
	const account = options.find((option) => option.authType === "oauth");
	const key = options.find((option) => option.authType === "api_key");
	const option = apiKey ? key : (account ?? key);
	if (!option) return { error: fill("{0} has no API key login. Omit --api-key to sign in.", name) };
	if (option.authType === "api_key" && !option.method?.login) {
		return { error: fill("{0} is configured outside {1}.", option.method?.name ?? t("Authentication"), APP_NAME) };
	}
	return { option };
}

async function selectInTerminal(
	message: string,
	options: readonly { id: string; label: string; description?: string }[],
	terminal: AuthTerminal,
	signal: AbortSignal,
): Promise<string> {
	terminal.write(message);
	options.forEach((option, index) => {
		terminal.write(`  ${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`);
	});
	for (;;) {
		const answer = (await terminal.question(fill("Select 1-{0}: ", String(options.length)), signal)).trim();
		const option = /^\d+$/u.test(answer) ? options[Number(answer) - 1] : undefined;
		if (option) return option.id;
		terminal.write(fill("Enter a number from 1 to {0}.", String(options.length)));
	}
}

/** The provider's prompts and events, in the terminal, for the chosen sign-in method. */
function createInteraction(
	providerId: string,
	type: "oauth" | "api_key",
	request: LoginRequest,
	terminal: AuthTerminal,
	signal: AbortSignal,
): AuthInteraction {
	// An account sign-in lists the browser method first, as /login shows it; an API key setup asks every choice.
	const methodChoice = type === "api_key" ? "ask" : request.browser ? "browser" : "other";
	let skippedMethods: string[] = [];
	let key = request.key;

	const needTerminal = () => {
		if (!terminal.interactive) throw new Error(fill('"{0}" requires an interactive terminal.', LOGIN_USAGE));
	};

	async function selectMethod(prompt: Extract<AuthPrompt, { type: "select" }>, promptSignal: AbortSignal) {
		const [first, ...others] = prompt.options;
		if (methodChoice === "browser" && first) {
			skippedMethods = others.map((option) => option.label);
			return first.id;
		}
		if (methodChoice === "other" && first) {
			const [onlyOther, ...moreOthers] = others;
			// A provider whose only method is the browser sign-in still gets it, without opening the browser.
			if (!onlyOther) return first.id;
			if (moreOthers.length === 0) {
				terminal.write(`${t(prompt.message)} ${t(onlyOther.label)}`);
				return onlyOther.id;
			}
			needTerminal();
			return selectInTerminal(t(prompt.message), others, terminal, promptSignal);
		}
		needTerminal();
		return selectInTerminal(t(prompt.message), prompt.options, terminal, promptSignal);
	}

	return {
		signal,
		async prompt(prompt) {
			// The browser callback can finish a step before the pasted code, cancelling just that prompt.
			const promptSignal = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
			if (prompt.type === "select") return selectMethod(prompt, promptSignal);
			// The key given on the command line answers the provider's first secret prompt.
			if (prompt.type === "secret" && key !== undefined) {
				const given = key;
				key = undefined;
				return given;
			}
			needTerminal();
			const placeholder = prompt.placeholder ? ` (${prompt.placeholder})` : "";
			const message = `${t(prompt.message)}${placeholder}: `;
			return prompt.type === "secret"
				? terminal.secret(message, promptSignal)
				: terminal.question(message, promptSignal);
		},
		notify(event: AuthEvent) {
			if (event.type === "auth_url") {
				terminal.write(fill("Open this URL to sign in:\n  {0}", displayUrl(event.url)));
				if (event.instructions) terminal.write(t(event.instructions));
				const target = webUrl(event.url);
				if (target !== undefined && request.browser) terminal.openUrl(target);
				// Providers without a method choice have nothing else to offer, so they get no hint.
				const rerun = `"${APP_NAME} auth login ${providerId} --no-browser"`;
				const [onlyMethod, ...moreMethods] = skippedMethods;
				if (onlyMethod !== undefined && moreMethods.length === 0) {
					terminal.write(fill('To use "{0}" instead, run {1}', t(onlyMethod), rerun));
				} else if (onlyMethod !== undefined) {
					const labels = skippedMethods.map((label) => `"${t(label)}"`).join(", ");
					terminal.write(fill("Other sign-in methods: {0}. Run {1} to choose one.", labels, rerun));
				}
			} else if (event.type === "device_code") {
				terminal.write(
					fill("Open {0} and enter code: {1}", displayUrl(event.verificationUri), printable(event.userCode)),
				);
				const target = webUrl(event.verificationUri);
				if (target !== undefined && request.browser) terminal.openUrl(target);
				terminal.write(t("Waiting for authentication..."));
			} else if (event.type === "info") {
				terminal.write(t(event.message));
				for (const link of event.links ?? []) {
					terminal.write(`  ${link.label ? `${t(link.label)}: ` : ""}${displayUrl(link.url)}`);
				}
			} else {
				terminal.write(t(event.message));
			}
		},
	};
}

/** Run `prism auth login <provider>` and return the exit code. */
export async function runAuthLogin(args: readonly string[], options: AuthLoginOptions): Promise<number> {
	const { modelRuntime, terminal, signal } = options;
	const request = parseLoginRequest(args);
	if ("error" in request) {
		terminal.error(request.error);
		return 1;
	}

	const matches = matchLoginProviderOptions(loginProviderOptions(modelRuntime), request.providerRef);
	if (matches.length === 0) {
		const ids = [...new Set(loginProviderOptions(modelRuntime).map((option) => option.id))].sort();
		terminal.error(fill('Unknown provider "{0}".', printable(request.providerRef)));
		terminal.error(fill("Providers: {0}", ids.join(", ")));
		return 1;
	}
	// Two providers may share a name; the first one's options.
	const providerOptions = matches.filter((option) => option.id === matches[0]!.id);
	const selected = selectOption(providerOptions, request.apiKey);
	if ("error" in selected) {
		terminal.error(selected.error);
		return 1;
	}
	const { option } = selected;
	const type = option.authType;
	if (!terminal.interactive && request.key === undefined) {
		terminal.error(fill('"{0}" requires an interactive terminal.', LOGIN_USAGE));
		if (providerOptions.some((candidate) => candidate.authType === "api_key" && candidate.method?.login)) {
			terminal.error(
				fill("To save an API key without one: {0}", `${APP_NAME} auth login ${option.id} --api-key <key>`),
			);
		}
		return 1;
	}

	try {
		// warn before a Claude subscription sign-in, as /login does (src/fork/anthropic-subscription.ts).
		if (isAnthropicSubscription(option)) {
			terminal.write(t(ANTHROPIC_SUBSCRIPTION_RISK));
			const go = await selectInTerminal(
				t(ANTHROPIC_SUBSCRIPTION_TITLE),
				[
					{ id: "go", label: t(ANTHROPIC_SUBSCRIPTION_GO) },
					{ id: "back", label: t("Back") },
				],
				terminal,
				signal,
			);
			if (go !== "go") throw new Error(LOGIN_CANCELLED);
		}
		await modelRuntime.login(option.id, type, createInteraction(option.id, type, request, terminal, signal), {
			getDeviceId: options.getDeviceId,
		});
	} catch (error: unknown) {
		const cancelled =
			(signal.aborted || errorMessage(error) === LOGIN_CANCELLED) &&
			!(error instanceof CredentialSynchronizationError);
		terminal.error(
			cancelled ? t("Login cancelled.") : t(loginFailureMessage(type, option.name, error) ?? errorMessage(error)),
		);
		return 1;
	}

	const actionLabel = loginActionLabel(type, option.name, option.id);
	terminal.write(fill("{0}. Credentials saved to {1}", actionLabel, getAuthPath()));
	// The provider's catalog now, since a dynamic catalog stays empty until its first authenticated refresh.
	try {
		const warning = await refreshCatalogAfterLogin(modelRuntime, option.id, actionLabel);
		if (warning) terminal.write(warning);
	} catch (error: unknown) {
		terminal.write(catalogRefreshFailure(actionLabel, error));
	}
	return 0;
}

/**
 * Run `prism auth logout <provider>`: remove the credential `prism auth login` or /login stored, and return the exit
 * code. Environment variables and models.json config stay, as with /logout; nothing stored is not an error.
 */
export async function runAuthLogout(args: readonly string[], options: AuthLogoutOptions): Promise<number> {
	const { modelRuntime, terminal } = options;
	const [providerRef, ...rest] = args;
	if (providerRef === undefined || !providerRef.trim() || providerRef.startsWith("-") || rest.length > 0) {
		terminal.error(fill("Usage: {0}", LOGOUT_USAGE));
		return 1;
	}

	let stored: AuthSelectorProvider[];
	try {
		stored = await logoutProviderOptions(modelRuntime);
	} catch (error: unknown) {
		terminal.error(fill("Could not read stored credentials: {0}", errorMessage(error)));
		return 1;
	}
	// Stored credentials of providers added by extensions, not loaded here, match by their id.
	const credential = matchLoginProviderOptions(stored, providerRef)[0];
	if (!credential) {
		const ref = providerRef.trim().toLowerCase();
		const provider = modelRuntime
			.getProviders()
			.find((candidate) => candidate.id.toLowerCase() === ref || candidate.name.toLowerCase() === ref);
		if (provider) {
			terminal.write(
				fill(
					"No stored credentials for {0}. Environment variables and models.json config are unchanged.",
					provider.name,
				),
			);
			return 0;
		}
		terminal.error(fill('Unknown provider "{0}".', printable(providerRef)));
		terminal.error(fill("Stored credentials: {0}", stored.map((option) => option.id).join(", ") || t("none")));
		return 1;
	}

	const result = await logoutProvider(modelRuntime, credential);
	if ("error" in result) {
		terminal.error(t(result.error));
		return 1;
	}
	terminal.write(t(result.message));
	return 0;
}

function readSecret(message: string, signal: AbortSignal, onInterrupt: () => void): Promise<string> {
	const stdin = process.stdin;
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error(LOGIN_CANCELLED));
			return;
		}
		let value = "";
		const finish = () => {
			stdin.off("data", onData);
			signal.removeEventListener("abort", onAbort);
			stdin.setRawMode(false);
			stdin.pause();
			process.stdout.write("\n");
		};
		const onAbort = () => {
			finish();
			reject(new Error(LOGIN_CANCELLED));
		};
		const onData = (data: Buffer) => {
			const chunk = data.toString("utf8");
			// Escape sequences such as arrow keys are not part of a key.
			if (chunk.startsWith("\u001b")) return;
			for (const char of chunk) {
				if (char === "\r" || char === "\n") {
					finish();
					resolve(value);
					return;
				}
				if (char === "\u0003" || char === "\u0004") {
					onInterrupt();
					return;
				}
				if (char === "\u007f" || char === "\b") value = Array.from(value).slice(0, -1).join("");
				else if (char >= " ") value += char;
			}
		};
		process.stdout.write(message);
		stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", onData);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function readLine(message: string, signal: AbortSignal, onInterrupt: () => void): Promise<string> {
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	const interrupted = new AbortController();
	// EOF closes readline without settling its question; Ctrl+C only pauses it.
	const interrupt = () => interrupted.abort();
	readline.on("SIGINT", interrupt);
	readline.on("close", interrupt);
	try {
		return await readline.question(message, { signal: AbortSignal.any([signal, interrupted.signal]) });
	} catch (error) {
		if (interrupted.signal.aborted) onInterrupt();
		throw error;
	} finally {
		readline.off("close", interrupt);
		readline.off("SIGINT", interrupt);
		readline.close();
	}
}

/** The terminal on stdin and stdout; `onInterrupt` runs on Ctrl+C, or EOF in a question. */
function processTerminal(onInterrupt: () => void): AuthTerminal {
	return {
		interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
		write: (line) => process.stdout.write(`${line}\n`),
		error: (line) => process.stderr.write(`${line}\n`),
		question: (message, signal) => readLine(message, signal, onInterrupt),
		secret: (message, signal) => readSecret(message, signal, onInterrupt),
		openUrl: openBrowser,
	};
}

/** `prism auth login|logout …`, run when it is the command; false otherwise. */
export async function runAuthLoginCommand(args: readonly string[]): Promise<boolean> {
	if (args[0] !== "auth" || (args[1] !== "login" && args[1] !== "logout")) return false;
	// main() already applied --offline.
	const rest = args.slice(2).filter((arg) => arg !== "--offline");
	const cwd = process.cwd();
	const settingsManager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
	setLanguage(resolveLanguage(settingsManager.getLanguage()));
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, signal: AbortSignal.timeout(15_000) });

	if (args[1] === "logout") {
		process.exitCode = await runAuthLogout(rest, {
			modelRuntime,
			terminal: { write: (line) => console.log(line), error: (line) => console.error(line) },
		});
		return true;
	}
	const controller = new AbortController();
	const interrupt = () => controller.abort();
	process.on("SIGINT", interrupt);
	try {
		process.exitCode = await runAuthLogin(rest, {
			modelRuntime,
			terminal: processTerminal(interrupt),
			signal: controller.signal,
			getDeviceId: () => settingsManager.getOrCreateDeviceId(),
		});
	} finally {
		process.off("SIGINT", interrupt);
	}
	return true;
}
