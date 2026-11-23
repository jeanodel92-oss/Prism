// `/login` and `/logout` as native screens of the Prism window. The same menus as the terminal's
// (the method, then the provider, or the provider named after /login), the same sign-in (`ModelRuntime.login`, its
// prompts and events shown as the terminal's login dialog shows them), the same model chosen after it, catalog
// refreshed and checklist of the provider's models, and the same messages (login-operations.ts, login-models.ts).
// Back on a sign-in in progress cancels it, as Escape does in the terminal.
import * as path from "node:path";
import type { AuthEvent, AuthPrompt, Model } from "@earendil-works/pi-ai";
import { APP_NAME, getAuthPath, getDocsPath, getModelsPath } from "../config.ts";
import type { AgentSession } from "../core/agent-session.ts";
import type { ExtensionContext } from "../core/extensions/types.ts";
import { CredentialSynchronizationError } from "../core/model-runtime.ts";
import { webUrl } from "../modes/interactive/components/login-dialog.ts";
import {
	type AuthSelectorProvider,
	formatAuthSelectorProviderStatus,
	formatAuthSelectorProviderType,
} from "../modes/interactive/components/oauth-selector.ts";
import { stripAnsi } from "../utils/ansi.ts";
import { openBrowser } from "../utils/open-browser.ts";
import {
	ANTHROPIC_SUBSCRIPTION_GO,
	ANTHROPIC_SUBSCRIPTION_RISK,
	ANTHROPIC_SUBSCRIPTION_TITLE,
	isAnthropicSubscription,
	loginWarningTone,
} from "./anthropic-subscription.ts";
import { connectCompatibleServer } from "./compatible-server.ts";
import { fill, t } from "./i18n/index.ts";
import { type LoginModelsChoice, loginModelsChoice } from "./login-models.ts";
import {
	catalogRefreshFailure,
	compatibleServerFailure,
	deferModelSelection,
	finishCompatibleServer,
	LOGIN_CANCELLED,
	type LoginMethod,
	loginActionLabel,
	loginFailureMessage,
	loginMethods,
	loginModelsKeep,
	loginProviderOptions,
	logoutProvider,
	logoutProviderOptions,
	matchLoginProviderOptions,
	NO_STORED_CREDENTIALS,
	noLoginProvidersMessage,
	refreshCatalogAfterLogin,
	selectModelAfterLogin,
} from "./login-operations.ts";
import { type NativeAction, NativeFlow, showNativeFlow } from "./native-flow.ts";

type Link = { url: string; label?: string };
type Choice = { id: string; label: string; description?: string };

/** What the terminal's login dialog shows between two prompts: the sign-in page, a code, what the provider says. */
/** a warning shown in bold, red (error) or yellow (warning), after the screen's lines. */
type Alert = { text: string; tone: "error" | "warning" };
type Dialog = { title: string; lines: string[]; links: Link[]; notes: string[]; controller: AbortController };

export class NativeLoginView extends NativeFlow {
	private dialog: Dialog | undefined;
	/** The reader is not at this computer (the phone app): a sign-in page opened here would reach nobody. */
	private readonly away: boolean;
	/** A sign-in was stopped because it needs a browser on this computer. */
	needsBrowserHere = false;

	constructor(changed: () => void, title: string, away = false) {
		super(changed, { screenId: "loading", kind: "detail", title, busy: true });
		this.away = away;
	}

	override close(): void {
		super.close();
		this.dialog?.controller.abort();
	}

	/** The chosen id; `undefined` on Back. */
	choose(
		screenId: string,
		title: string,
		items: Choice[],
		extra: { lines?: string[]; alerts?: Alert[]; hint?: string; query?: string } = {},
	) {
		const prefix = this.nextPrefix();
		return this.wait<string>((finish) => {
			this.show(
				{
					screenId,
					kind: "choice",
					title,
					lines: extra.lines ?? [],
					...(extra.alerts ? { alerts: extra.alerts } : {}),
					hint: extra.hint ?? "back",
					// The filter typed first, as `/login <name>` fills the terminal's search field.
					...(extra.query ? { query: extra.query } : {}),
					items: items.map((item) => ({ ...item, id: prefix + item.id })),
				},
				(action) => {
					if (action.kind === "back") {
						finish(undefined);
						return true;
					}
					const id = this.itemOf(action, prefix) ?? "";
					if (action.kind !== "activate" || !items.some((item) => item.id === id)) return false;
					finish(id);
					return true;
				},
			);
			return () => {};
		});
	}

	/** Text to read until Back. */
	info(title: string, lines: string[]): Promise<void> {
		return this.wait<void>((finish) => {
			this.show({ screenId: "info", kind: "detail", title, lines }, (action) => {
				if (action.kind !== "back") return false;
				finish(undefined);
				return true;
			});
			return () => {};
		}).then(() => {});
	}

	busy(title: string, lines: string[]): void {
		if (!this.closed) this.show({ screenId: "busy", kind: "detail", title, lines, busy: true });
	}

	/** A sign-in starts: its dialog, empty, with Cancel. */
	begin(title: string, lines: string[] = []): AbortController {
		const controller = new AbortController();
		if (this.closed) controller.abort();
		this.dialog = { title, lines, links: [], notes: [], controller };
		this.showDialog();
		return controller;
	}

	end(): void {
		this.dialog = undefined;
	}

	private showDialog(): void {
		const dialog = this.dialog;
		if (!dialog || this.closed) return;
		this.show(
			{
				screenId: "dialog",
				kind: "detail",
				title: dialog.title,
				lines: dialog.lines.map((line) => t(line)),
				links: dialog.links,
				notes: dialog.notes,
				doneLabel: t("Cancel"),
			},
			(action) => {
				if (action.kind !== "back") return false;
				dialog.controller.abort();
				return true;
			},
		);
	}

	/** An event of the sign-in, shown as the terminal's dialog shows it (login-dialog.ts). */
	notify(event: AuthEvent): void {
		const dialog = this.dialog;
		if (!dialog) return;
		if (event.type === "auth_url") {
			// From the phone: the page's way back is this computer's localhost, which the phone's
			// browser cannot reach. The sign-in stops; the reader is told to do it at the computer.
			if (this.away) {
				this.needsBrowserHere = true;
				dialog.controller.abort();
				return;
			}
			dialog.lines = [];
			dialog.links = [{ url: event.url }];
			dialog.notes = event.instructions ? [t(event.instructions)] : [];
			// The shared launcher also opens files and custom protocols: only a web URL is opened (upstream 89c921d8b).
			const target = webUrl(event.url);
			if (target !== undefined) openBrowser(target);
		} else if (event.type === "device_code") {
			dialog.lines = [];
			dialog.links = [{ url: event.verificationUri }];
			dialog.notes = [
				fill("On the web page above, enter this code: {0}", event.userCode),
				t("Waiting for authentication..."),
			];
		} else if (event.type === "info") {
			dialog.notes.push(t(event.message));
			dialog.links.push(...(event.links ?? []));
		} else {
			dialog.notes.push(t(event.message));
		}
		this.showDialog();
	}

	/** A prompt of the sign-in: a choice or a field under the dialog; Back cancels the sign-in. */
	async prompt(prompt: AuthPrompt): Promise<string> {
		const dialog = this.dialog;
		if (!dialog || prompt.signal?.aborted) throw new Error(LOGIN_CANCELLED);
		const prefix = this.nextPrefix();
		const answer = await this.wait<{ value: string } | { withdrawn: true }>((finish) => {
			// The provider no longer needs the answer (its callback came first): back to the dialog.
			const withdraw = () => finish({ withdrawn: true });
			prompt.signal?.addEventListener("abort", withdraw, { once: true });
			const handle = (action: NativeAction) => {
				if (action.kind === "back") {
					finish(undefined);
					return true;
				}
				if (prompt.type === "select") {
					const id = this.itemOf(action, prefix) ?? "";
					if (action.kind !== "activate" || !prompt.options.some((option) => option.id === id)) return false;
					finish({ value: id });
					return true;
				}
				if (action.kind !== "input" || typeof action.value !== "string") return false;
				finish({ value: action.value });
				return true;
			};
			const lines = dialog.lines.map((line) => t(line));
			const shown = { title: dialog.title, doneLabel: t("Cancel") };
			if (prompt.type === "select") {
				// Claude Code's warning in bold yellow, once (the provider also notifies it).
				const message = t(prompt.message);
				const tone = loginWarningTone(prompt.message);
				this.show(
					{
						...shown,
						...(tone
							? {
									lines: [...lines, ...dialog.notes.filter((note) => note !== message)],
									alerts: [{ text: message, tone }],
								}
							: { lines: [...lines, ...dialog.notes, message] }),
						screenId: "prompt",
						kind: "choice",
						items: prompt.options.map((option) => ({
							id: prefix + option.id,
							label: option.label,
							...(option.description ? { description: option.description } : {}),
						})),
					},
					handle,
				);
			} else {
				this.show(
					{
						...shown,
						// As the terminal's dialog: the page to open, what the provider said, then the question.
						lines,
						links: dialog.links,
						notes: [...dialog.notes, t(prompt.message)],
						screenId: "prompt",
						kind: "input",
						placeholder: prompt.placeholder ? fill("e.g., {0}", prompt.placeholder) : "",
						...(prompt.type === "secret" ? { secret: true } : {}),
					},
					handle,
				);
			}
			return () => prompt.signal?.removeEventListener("abort", withdraw);
		});
		if (!answer) {
			dialog.controller.abort();
			throw new Error(LOGIN_CANCELLED);
		}
		this.showDialog();
		if ("withdrawn" in answer) throw new Error(LOGIN_CANCELLED);
		return answer.value;
	}

	/** The provider's models to offer in /model; `undefined` on Back, which keeps them all. */
	chooseModels(providerName: string, choice: LoginModelsChoice): Promise<string[] | undefined> {
		const prefix = this.nextPrefix();
		const checked = new Set(choice.checked);
		return this.wait<string[]>((finish) => {
			const render = () =>
				this.show(
					{
						screenId: "models",
						kind: "multiSelect",
						title: fill("Models from {0}", providerName),
						lines: [
							t(
								"Checked models appear in /model; recent ones are checked. Change this later with /scoped-models.",
							),
						],
						enableSearch: choice.models.length > 6,
						items: choice.models.map((model) => ({
							id: prefix + model.id,
							label: model.id,
							description: [model.releaseDate, model.deprecated ? t("deprecated") : undefined]
								.filter(Boolean)
								.join(" · "),
							searchText: model.name,
							selected: checked.has(model.id),
						})),
						actions: [
							{
								id: `${prefix}save`,
								label: `${t("Save")} (${fill("{0} of {1} models", String(checked.size), String(choice.models.length))})`,
							},
						],
						doneLabel: t("Keep all models"),
					},
					(action) => {
						if (action.kind === "back") {
							finish(undefined);
							return true;
						}
						const id = this.itemOf(action, prefix) ?? "";
						if (action.kind === "activate" && action.itemId === `${prefix}save`) {
							finish(choice.models.filter((model) => checked.has(model.id)).map((model) => model.id));
							return true;
						}
						if (action.kind !== "multiSelect" || typeof action.selected !== "boolean") return false;
						if (!choice.models.some((model) => model.id === id)) return false;
						if (action.selected) checked.add(id);
						else checked.delete(id);
						render();
						return true;
					},
				);
			render();
			return () => {};
		});
	}
}

/** A provider's row, as the terminal's provider selector writes it. */
function providerChoice(option: AuthSelectorProvider, showType: boolean): Choice {
	const type = showType
		? t(formatAuthSelectorProviderType(option.authType, option.subscription, option.id))
		: undefined;
	const status = stripAnsi(formatAuthSelectorProviderStatus(option)).trim().replace(/^• /, "");
	return {
		id: `${option.id}:${option.authType}`,
		label: option.name,
		description: [type, status].filter(Boolean).join(" · "),
	};
}

type Outcome = "done" | "back";

const SIGN_IN_AT_THE_COMPUTER =
	"This sign-in goes through a web browser on the computer. Run /login there; an API key can be saved from here.";

class LoginRun {
	private readonly ctx: ExtensionContext;
	private readonly session: AgentSession;
	private readonly view: NativeLoginView;

	constructor(ctx: ExtensionContext, session: AgentSession, view: NativeLoginView) {
		this.ctx = ctx;
		this.session = session;
		this.view = view;
	}

	private get runtime() {
		return this.session.modelRuntime;
	}

	/** `/login [provider]`, as `handleLoginCommand` runs it. */
	async start(providerRef: string | undefined): Promise<void> {
		if (!providerRef) return this.methods();
		const options = matchLoginProviderOptions(loginProviderOptions(this.runtime), providerRef);
		if (options.length === 1) {
			await this.login(options[0]!);
			return;
		}
		if (options.length > 1 && new Set(options.map((option) => option.id)).size === 1) return this.methods(options);
		await this.providers(undefined, providerRef);
	}

	private async methods(providerOptions?: AuthSelectorProvider[]): Promise<void> {
		const { title, methods } = loginMethods(providerOptions);
		if (methods.length === 0) {
			this.ctx.ui.notify(t("No login methods available."), "info");
			return;
		}
		if (providerOptions && methods.length === 1) {
			await this.login(providerOptions[0]!);
			return;
		}
		for (;;) {
			const method = (await this.view.choose(
				"methods",
				t(title),
				methods.map((entry) => ({ id: entry.method, label: t(entry.label) })),
				{ hint: "close" },
			)) as LoginMethod | undefined;
			if (!method) return;
			if (method === "server") return this.server();
			if (providerOptions) {
				const option = providerOptions.find((provider) => provider.authType === method);
				if (!option || (await this.login(option)) === "done") return;
			} else if ((await this.providers(method)) === "done") return;
		}
	}

	private async providers(authType?: AuthSelectorProvider["authType"], filter?: string): Promise<Outcome> {
		const options = loginProviderOptions(this.runtime, authType);
		if (options.length === 0) {
			this.ctx.ui.notify(t(noLoginProvidersMessage(authType)), "info");
			return "done";
		}
		for (;;) {
			const id = await this.view.choose(
				"providers",
				t("Choose a model service to connect to:"),
				options.map((option) => providerChoice(option, !authType)),
				{ hint: authType ? "back" : "close", query: filter },
			);
			const option = options.find((candidate) => `${candidate.id}:${candidate.authType}` === id);
			if (!option) return authType ? "back" : "done";
			if ((await this.login(option)) === "done") return "done";
		}
	}

	/** `startProviderLogin`: an account, an API key, or a provider configured outside Prism. */
	private async login(option: AuthSelectorProvider): Promise<Outcome> {
		// Anthropic's terms forbid a Claude subscription in Prism; the user decides knowing the risk.
		if (isAnthropicSubscription(option)) {
			const go = await this.view.choose(
				"anthropic-subscription",
				t(ANTHROPIC_SUBSCRIPTION_TITLE),
				[
					{ id: "go", label: t(ANTHROPIC_SUBSCRIPTION_GO) },
					{ id: "back", label: t("Back") },
				],
				{ alerts: [{ text: t(ANTHROPIC_SUBSCRIPTION_RISK), tone: "error" }] },
			);
			if (go !== "go") return "back";
		}
		if (option.authType === "oauth") return this.signIn(option, "oauth");
		if (option.method?.login) return this.signIn(option, "api_key");
		await this.view.info(fill("{0} setup", option.name), [
			fill("{0} is configured outside {1}.", option.method?.name ?? t("Authentication"), APP_NAME),
		]);
		return "back";
	}

	private async signIn(option: AuthSelectorProvider, type: "oauth" | "api_key"): Promise<Outcome> {
		const previousModel = this.session.model;
		const details =
			option.id === "amazon-bedrock"
				? [
						"You can also use an AWS profile, IAM keys, or role-based credentials.",
						"See:",
						`  ${path.join(getDocsPath(), "providers.md")}`,
					]
				: [];
		const title = fill("Login to {0}", option.name);
		const controller = this.view.begin(title, details);
		this.view.needsBrowserHere = false;
		try {
			await this.runtime.login(
				option.id,
				type,
				{
					signal: controller.signal,
					prompt: (prompt) => this.view.prompt(prompt),
					notify: (event) => this.view.notify(event),
				},
				{ getDeviceId: () => this.session.settingsManager.getOrCreateDeviceId() },
			);
		} catch (error: unknown) {
			// Cancelled from the window (Back, or the panel closed): back to the menu it came from.
			const cancelled = controller.signal.aborted && !(error instanceof CredentialSynchronizationError);
			const failure = cancelled ? undefined : loginFailureMessage(type, option.name, error);
			if (failure) {
				this.ctx.ui.notify(failure, "error");
				return "done";
			}
			if (this.view.needsBrowserHere) await this.view.info(title, [t(SIGN_IN_AT_THE_COMPUTER)]);
			return "back";
		} finally {
			this.view.end();
		}
		await this.afterLogin(option.id, option.name, type, previousModel);
		return "done";
	}

	/** `completeProviderAuthentication`: the model, the catalog, then the models to offer. */
	private async afterLogin(
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
		previousModel: Model<any> | undefined,
	): Promise<void> {
		const actionLabel = loginActionLabel(authType, providerName, providerId);
		const defer = deferModelSelection(this.session, providerId, previousModel);
		const finish = async () => {
			const { selectedModel, selectionError } = await selectModelAfterLogin(
				this.session,
				providerId,
				actionLabel,
				previousModel,
			);
			if (selectedModel) {
				this.ctx.ui.notify(
					fill("{0}. Selected {1}. Credentials saved to {2}", actionLabel, selectedModel.id, getAuthPath()),
					"info",
				);
				return;
			}
			this.ctx.ui.notify(fill("{0}. Credentials saved to {1}", actionLabel, getAuthPath()), "info");
			if (selectionError) this.ctx.ui.notify(selectionError, "error");
		};
		if (defer) {
			this.ctx.ui.notify(
				fill("{0}. Credentials saved to {1}. Refreshing model catalog…", actionLabel, getAuthPath()),
				"info",
			);
		} else {
			await finish();
		}
		this.view.busy(fill("Login to {0}", providerName), [t("Refreshing model catalogs…")]);
		try {
			const warning = await refreshCatalogAfterLogin(this.runtime, providerId, actionLabel);
			if (warning) this.ctx.ui.notify(warning, "warning");
			// A model chosen while the catalog was refreshed stays.
			if (defer && this.session.model === previousModel) await finish();
			await this.offerModels(providerId, providerName);
		} catch (error: unknown) {
			this.ctx.ui.notify(catalogRefreshFailure(actionLabel, error), "warning");
		}
	}

	/** fork: the checklist of the provider's models (login-models.ts). */
	private async offerModels(providerId: string, providerName: string, added?: readonly string[]): Promise<void> {
		const settings = this.session.settingsManager;
		const choice = loginModelsChoice({
			providerId,
			available: this.runtime.getAvailableSnapshot(),
			patterns: settings.getEnabledModels(),
			keep: loginModelsKeep(this.session, providerId),
			added,
			savePatterns: (patterns) => settings.setEnabledModels(patterns),
			setScopedModels: (models) => this.session.setScopedModels(models),
		});
		if (!choice) return;
		const ids = await this.view.chooseModels(providerName, choice);
		if (ids) choice.save(ids);
		else choice.keepAll();
	}

	/** fork: a server from its URL (compatible-server.ts), as `showCompatibleServerLogin`. */
	private async server(): Promise<void> {
		const previousModel = this.session.model;
		const controller = this.view.begin(t("Connect a compatible server"));
		const interaction = {
			signal: controller.signal,
			prompt: (prompt: AuthPrompt) => this.view.prompt(prompt),
			notify: (event: AuthEvent) => this.view.notify(event),
		};
		let server: Awaited<ReturnType<typeof connectCompatibleServer>>;
		try {
			server = await connectCompatibleServer(this.runtime, getModelsPath(), interaction);
		} catch (error: unknown) {
			const failure = controller.signal.aborted ? undefined : compatibleServerFailure(error);
			if (failure) this.ctx.ui.notify(failure, "error");
			return;
		} finally {
			this.view.end();
		}
		const { message } = await finishCompatibleServer(this.session, server, getModelsPath(), previousModel);
		this.ctx.ui.notify(message, "info");
		await this.offerModels(server.providerId, server.providerId, server.added);
	}

	/** `/logout`: a stored credential, removed. */
	async logout(): Promise<void> {
		let options: AuthSelectorProvider[];
		try {
			options = await logoutProviderOptions(this.runtime);
		} catch (error) {
			this.ctx.ui.notify(
				fill("Could not read stored credentials: {0}", error instanceof Error ? error.message : String(error)),
				"error",
			);
			return;
		}
		if (options.length === 0) {
			this.ctx.ui.notify(t(NO_STORED_CREDENTIALS), "info");
			return;
		}
		const id = await this.view.choose(
			"logout",
			t("Select provider to logout:"),
			options.map((option) => providerChoice(option, true)),
			{ hint: "close" },
		);
		const option = options.find((candidate) => `${candidate.id}:${candidate.authType}` === id);
		if (!option) return;
		this.view.busy(t("Logout"), []);
		const result = await logoutProvider(this.runtime, option);
		if ("error" in result) this.ctx.ui.notify(result.error, "error");
		else this.ctx.ui.notify(result.message, "info");
	}
}

/** `/login [provider]` in the Prism window; `away`: asked from the phone app, the reader is not at this computer. */
export function showNativeLogin(
	ctx: ExtensionContext,
	session: AgentSession,
	providerRef?: string,
	away = false,
): Promise<void> {
	return showNativeFlow<NativeLoginView>(
		ctx,
		(changed) => new NativeLoginView(changed, t("Login"), away),
		(view) => new LoginRun(ctx, session, view).start(providerRef),
	);
}

/** `/logout` in the Prism window. */
export function showNativeLogout(ctx: ExtensionContext, session: AgentSession): Promise<void> {
	return showNativeFlow<NativeLoginView>(
		ctx,
		(changed) => new NativeLoginView(changed, t("Logout")),
		(view) => new LoginRun(ctx, session, view).logout(),
	);
}
