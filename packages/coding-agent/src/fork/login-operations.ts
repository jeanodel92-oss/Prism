// what /login and /logout do, for the terminal (interactive-mode.ts) and the Prism window
// (login-native.ts) alike: the providers offered, the methods' labels, the model chosen after a login, the catalog
// refreshed, and the messages. Each side keeps only its own screens.
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "../core/agent-session.ts";
import { defaultModelPerProvider } from "../core/model-resolver.ts";
import { CredentialSynchronizationError, type ModelRuntime } from "../core/model-runtime.ts";
import type { AuthSelectorProvider } from "../modes/interactive/components/oauth-selector.ts";
import type { CompatibleServer } from "./compatible-server.ts";
import { fill, t } from "./i18n/index.ts";
import { isOfferedAtLogin, loginMethodOptions, signsInWithAccount } from "./login-menu.ts";

const CATALOG_REFRESH_MS = 15_000;
const CREDENTIALS_MS = 15_000;

/** "Login cancelled": the user went back; nothing to report. */
export const LOGIN_CANCELLED = "Login cancelled";

export function isUnknownModel(model: Model<any> | undefined): boolean {
	return !!model && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}

export function hasDefaultModelProvider(providerId: string): providerId is keyof typeof defaultModelPerProvider {
	return providerId in defaultModelPerProvider;
}

/** Every way /login offers to sign in to each provider (one entry per provider and method), by name. */
export function loginProviderOptions(runtime: ModelRuntime, authType?: "oauth" | "api_key"): AuthSelectorProvider[] {
	const options: AuthSelectorProvider[] = [];
	for (const provider of runtime.getProviders()) {
		// fork: Radius is not offered at /login (src/fork/login-menu.ts); the provider stays.
		if (!isOfferedAtLogin(provider.id)) continue;
		const authStatus = runtime.getProviderAuthStatus(provider.id);
		const status = authStatus.configured
			? {
					type: runtime.isUsingOAuth(provider.id) ? ("oauth" as const) : ("api_key" as const),
					source: authStatus.label ?? authStatus.source,
				}
			: undefined;
		const subscription = provider.auth.oauth?.isSubscription === true;
		if ((!authType || authType === "oauth") && provider.auth.oauth) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType: "oauth",
				method: provider.auth.oauth,
				status,
				subscription,
			});
		}
		// Claude Code signs in with the user's own account (src/fork/login-menu.ts).
		const account = signsInWithAccount(provider.id);
		if ((!authType || authType === (account ? "oauth" : "api_key")) && provider.auth.apiKey) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType: "api_key",
				method: provider.auth.apiKey,
				status,
				subscription: subscription || account,
			});
		}
	}
	return options.sort((a, b) => a.name.localeCompare(b.name));
}

/** The credentials /login saved, which /logout removes, by provider name. */
export async function logoutProviderOptions(runtime: ModelRuntime): Promise<AuthSelectorProvider[]> {
	return (await runtime.listCredentials({ signal: AbortSignal.timeout(CREDENTIALS_MS) }))
		.map(({ providerId, type }) => {
			const provider = runtime.getProvider(providerId);
			return {
				id: providerId,
				name: provider?.name ?? providerId,
				authType: type,
				status: { type, source: "stored credential" },
				subscription: provider?.auth.oauth?.isSubscription === true,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** `/login <provider>`: the options of the provider with that exact ID or name, case aside. */
export function matchLoginProviderOptions(
	options: AuthSelectorProvider[],
	providerRef: string,
): AuthSelectorProvider[] {
	const ref = providerRef.trim().toLowerCase();
	if (!ref) return [];
	return options.filter((provider) => provider.id.toLowerCase() === ref || provider.name.toLowerCase() === ref);
}

export type LoginMethod = "server" | "oauth" | "api_key";

/**
 * The method menu: a compatible server (only without a provider), an account, an API key, in that order.
 * `providerOptions` are one provider's options, after `/login <provider>`; without them, every provider's.
 */
export function loginMethods(providerOptions?: AuthSelectorProvider[]): {
	title: string;
	methods: { method: LoginMethod; label: string }[];
} {
	const oauthProvider = providerOptions?.find((provider) => provider.authType === "oauth");
	const oauthLoginLabel =
		oauthProvider?.method && "loginLabel" in oauthProvider.method ? oauthProvider.method.loginLabel : undefined;
	const labels: Record<LoginMethod, string> = {
		server: "Connect a compatible server (URL)",
		oauth: oauthLoginLabel ?? "Sign in with an account",
		api_key: "Use an API key (an access key from the service)",
	};
	const available = providerOptions
		? new Set(providerOptions.map((provider) => provider.authType))
		: new Set<AuthSelectorProvider["authType"]>(["oauth", "api_key"]);
	const shown = loginMethodOptions({
		server: providerOptions ? undefined : labels.server,
		subscription: available.has("oauth") ? labels.oauth : undefined,
		apiKey: available.has("api_key") ? labels.api_key : undefined,
	});
	return {
		title: providerOptions?.[0]
			? `How would you like to connect to ${providerOptions[0].name}?`
			: "How would you like to connect?",
		methods: shown.map((label) => ({
			method: (Object.keys(labels) as LoginMethod[]).find((method) => labels[method] === label)!,
			label,
		})),
	};
}

/** What the provider choice says when no provider offers that method. */
export function noLoginProvidersMessage(authType?: AuthSelectorProvider["authType"]): string {
	return authType === "oauth"
		? "No account providers available."
		: authType === "api_key"
			? "No API key providers available."
			: "No login providers available.";
}

/** "Logged in to …" or "Saved API key for …": the start of every message after a login. */
export function loginActionLabel(authType: "oauth" | "api_key", providerName: string, providerId?: string): string {
	// Claude Code stores no key; Prism uses the Claude Code the user is logged in to.
	if (providerId !== undefined && signsInWithAccount(providerId)) return fill("Connected to {0}", providerName);
	return authType === "oauth" ? fill("Logged in to {0}", providerName) : fill("Saved API key for {0}", providerName);
}

function llamaCppPostLoginGuidance(actionLabel: string, loadedModelCount: number): string {
	// fork: translate display wrappers; keep data and model content unchanged.
	return loadedModelCount === 0
		? fill("{0}. No llama.cpp models are loaded. Use /llama to load a model, then /model to select it.", actionLabel)
		: fill("{0}. Use /model to select a loaded llama.cpp model, or /llama to manage models.", actionLabel);
}

/**
 * Whether the model is chosen only after the catalog refresh: a dynamic catalog may lack the provider's default model
 * until the first authenticated refresh.
 */
export function deferModelSelection(
	session: AgentSession,
	providerId: string,
	previousModel: Model<any> | undefined,
): boolean {
	return (
		isUnknownModel(previousModel) &&
		hasDefaultModelProvider(providerId) &&
		!session.modelRuntime
			.getAvailableSnapshot()
			.some((model) => model.provider === providerId && model.id === defaultModelPerProvider[providerId])
	);
}

/**
 * After a login with no model chosen yet: the provider's default model, selected and saved, or why none was.
 * Nothing happens when a model was already chosen.
 */
export async function selectModelAfterLogin(
	session: AgentSession,
	providerId: string,
	actionLabel: string,
	previousModel: Model<any> | undefined,
): Promise<{ selectedModel?: Model<any>; selectionError?: string }> {
	if (!isUnknownModel(previousModel)) return {};
	const providerModels = session.modelRuntime.getAvailableSnapshot().filter((model) => model.provider === providerId);
	// Matches LLAMA_PROVIDER_ID from extensions/llama/provider.ts; kept inline to avoid coupling to the built-in extension.
	if (providerId === "llama.cpp") {
		return { selectionError: llamaCppPostLoginGuidance(actionLabel, providerModels.length) };
	}
	if (!hasDefaultModelProvider(providerId)) {
		return {
			selectionError: fill(
				'{0}, but no default model is configured for provider "{1}". Use /model to select a model.',
				actionLabel,
				providerId,
			),
		};
	}
	if (providerModels.length === 0) {
		return {
			selectionError: fill(
				"{0}, but no models are available for that provider. Use /model to select a model.",
				actionLabel,
			),
		};
	}
	const defaultModelId = defaultModelPerProvider[providerId];
	// Radius catalogs vary by account; prefer balanced, then use catalog order.
	const selectedModel =
		providerModels.find((model) => model.id === defaultModelId) ??
		(providerId === "radius" ? providerModels[0] : undefined);
	if (!selectedModel) {
		return {
			selectionError: fill(
				'{0}, but its default model "{1}" is not available. Use /model to select a model.',
				actionLabel,
				String(defaultModelId),
			),
		};
	}
	try {
		await session.setModel(selectedModel, { persist: true });
		return { selectedModel };
	} catch (error: unknown) {
		return {
			selectionError: fill(
				"{0}, but selecting its default model failed: {1}. Use /model to select a model.",
				actionLabel,
				error instanceof Error ? error.message : String(error),
			),
		};
	}
}

/** The warning after a catalog refresh that failed outright: the refresh, or what followed it, threw. */
export function catalogRefreshFailure(actionLabel: string, error: unknown): string {
	return fill(
		"{0}, but its model catalog could not be refreshed: {1}",
		actionLabel,
		error instanceof Error ? error.message : String(error),
	);
}

/**
 * The provider's catalog after a login, within 15 s; the warning when it timed out or a source failed (cached models
 * are used). Rejects when the refresh itself throws (`catalogRefreshFailure`).
 */
export async function refreshCatalogAfterLogin(
	runtime: ModelRuntime,
	providerId: string,
	actionLabel: string,
): Promise<string | undefined> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), CATALOG_REFRESH_MS);
	try {
		const result = await runtime.refresh({ providers: [providerId], signal: controller.signal });
		if (result.aborted)
			return fill("{0}, but its model catalog refresh timed out; using cached models.", actionLabel);
		if (result.errors.size > 0)
			return fill("{0}, but its model catalog could not be refreshed; using cached models.", actionLabel);
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

/** Why a login failed; `undefined` when the user cancelled it. */
export function loginFailureMessage(
	authType: "oauth" | "api_key",
	providerName: string,
	error: unknown,
): string | undefined {
	const message = error instanceof Error ? error.message : String(error);
	if (message === LOGIN_CANCELLED && !(error instanceof CredentialSynchronizationError)) return undefined;
	if (authType === "oauth") {
		return error instanceof CredentialSynchronizationError
			? fill("Logged in to {0}, but local model state could not be synchronized: {1}", providerName, message)
			: `Failed to login to ${providerName}: ${message}`;
	}
	return error instanceof CredentialSynchronizationError
		? fill("API key saved for {0}, but the app could not update its model information: {1}", providerName, message)
		: fill("Failed to save API key for {0}: {1}", providerName, message);
}

export const NO_STORED_CREDENTIALS =
	"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.";

/** /logout of one stored credential: what to tell, as a status or an error. */
export async function logoutProvider(
	runtime: ModelRuntime,
	option: AuthSelectorProvider,
): Promise<{ message: string } | { error: string }> {
	try {
		await runtime.logout(option.id, { signal: AbortSignal.timeout(CREDENTIALS_MS) });
		return {
			message:
				option.authType === "oauth"
					? `Logged out of ${option.name}`
					: fill(
							"Removed stored API key for {0}. Environment variables and models.json config are unchanged.",
							option.name,
						),
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			error:
				error instanceof CredentialSynchronizationError
					? fill(
							"Credentials removed for {0}, but local model state could not be synchronized: {1}",
							option.name,
							message,
						)
					: fill("Logout failed: {0}", message),
		};
	}
}

/**
 * After a compatible server was added: its first model, selected and saved when no model was chosen yet, and the
 * message to show.
 */
export async function finishCompatibleServer(
	session: AgentSession,
	server: CompatibleServer,
	modelsPath: string,
	previousModel: Model<any> | undefined,
): Promise<{ message: string; selectedModel?: Model<any> }> {
	let selected = "";
	let selectedModel: Model<any> | undefined;
	const firstModel = session.modelRuntime.getModel(server.providerId, server.models[0]!);
	if (firstModel && (!previousModel || isUnknownModel(previousModel))) {
		await session.setModel(firstModel, { persist: true });
		selectedModel = firstModel;
		selected = fill(" Selected {0}.", firstModel.id);
	}
	return {
		message: fill(
			server.models.length === 1
				? "Added {0} ({1} model) to {2}.{3} Use /model to choose a model."
				: "Added {0} ({1} models) to {2}.{3} Use /model to choose a model.",
			server.providerId,
			String(server.models.length),
			modelsPath,
			selected,
		),
		selectedModel,
	};
}

/** Why a compatible server was not added; `undefined` when the user cancelled. */
export function compatibleServerFailure(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : String(error);
	return message === LOGIN_CANCELLED ? undefined : fill("Could not add the server: {0}", t(message));
}

/** The models of the provider the post-login checklist keeps checked: the current and the default one. */
export function loginModelsKeep(session: AgentSession, providerId: string): string[] {
	const keep: string[] = [];
	if (session.model?.provider === providerId) keep.push(session.model.id);
	if (hasDefaultModelProvider(providerId)) keep.push(defaultModelPerProvider[providerId]!);
	return keep;
}
