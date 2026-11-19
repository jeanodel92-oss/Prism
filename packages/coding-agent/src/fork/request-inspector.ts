/** fork: F-I3/F-J5 share the request facts captured at the existing transport hook. */
import { writeFileSync } from "node:fs";
import { type Component, getKeybindings, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { resolveToCwd } from "../core/tools/path-utils.ts";
import { theme } from "../modes/interactive/theme/theme.ts";
import { fill, t } from "./i18n/index.ts";
import { knownSecrets } from "./secrets/env.ts";
import { maskValue, type Secrets, secretName } from "./secrets/mask.ts";

interface RequestFacts {
	provider: string;
	model: string;
	endpoint?: string;
	prepared: unknown;
	payload?: unknown;
	responseReceived: boolean;
	correlationId: number;
}

let lastRequest: RequestFacts | undefined;
let previousWasLocal: boolean | undefined;
let requestSequence = 0;
let cloudWarningEnabled = true;

/** fork: request correlation used by the operation trace when one was captured. */
export function getLastRequestId(): number | undefined {
	return lastRequest?.correlationId;
}

export function setCloudWarningEnabled(enabled: boolean): void {
	cloudWarningEnabled = enabled;
}

export function capturePreparedRequest(
	model: { provider: string; id: string; baseUrl?: string },
	prepared: unknown,
): void {
	try {
		lastRequest = {
			provider: model.provider,
			model: model.id,
			endpoint: model.baseUrl,
			prepared: snapshot(prepared),
			responseReceived: false,
			correlationId: ++requestSequence,
		};
	} catch {
		lastRequest = undefined;
	}
}

/**
 * fork.10 (RAM pass, gui-fork10.md § 56): a deep copy of every request doubled the engine's allocations (the whole
 * conversation, twice per request) and kept two more copies of it alive. The request is built for each call and not
 * changed once handed to the transport (the cache warmer keeps it by reference too, sdk.ts), so only its top level
 * and its message list are copied: what /sent shows cannot grow with the conversation after it was sent.
 */
function snapshot(prepared: unknown): unknown {
	if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) return prepared;
	const copy: Record<string, unknown> = { ...(prepared as Record<string, unknown>) };
	if (Array.isArray(copy.messages)) copy.messages = [...copy.messages];
	return copy;
}

export function markProviderResponseReceived(model: { provider: string; id: string }): void {
	if (lastRequest?.provider === model.provider && lastRequest.model === model.id) lastRequest.responseReceived = true;
}

export function captureProviderPayload(
	payload: unknown,
	model?: { provider: string; id: string; baseUrl?: string },
): void {
	if (!lastRequest || (model && (lastRequest.provider !== model.provider || lastRequest.model !== model.id))) return;
	if (model?.baseUrl) lastRequest.endpoint = model.baseUrl;
	// The body as the provider hands it to its client, which serializes it unchanged (no deep copy, see snapshot()).
	lastRequest.payload = snapshot(payload);
}

const SECRET_VALUE =
	/\b(?:API[_-]?CANARY[_-]?[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+\S+|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;

/**
 * A copy to show or export: the known secrets masked in values and property names, the fields named as secrets and
 * the key-shaped values replaced. `text` adds patterns of the caller's own.
 */
export function redact(
	value: unknown,
	key = "",
	secrets: Secrets = knownSecrets(),
	text?: (text: string) => string,
): unknown {
	if (key && secretName(key)) return "[REDACTED]";
	return maskValue(value, secrets, {
		byName: "[REDACTED]",
		text: (input) => {
			const masked = input.replace(SECRET_VALUE, "[REDACTED]");
			return text ? text(masked) : masked;
		},
	});
}

export function isLocalEndpoint(endpoint: string | undefined): boolean {
	if (!endpoint) return false;
	try {
		const host = new URL(endpoint).hostname.toLowerCase();
		if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]") return true;
		if (host.startsWith("[fc") || host.startsWith("[fd") || /^\[fe[89ab]/.test(host)) return true;
		const ipv4 = host.split(".").map(Number);
		if (ipv4.length !== 4 || ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
		return (
			ipv4[0] === 10 ||
			ipv4[0] === 127 ||
			(ipv4[0] === 192 && ipv4[1] === 168) ||
			(ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
			(ipv4[0] === 169 && ipv4[1] === 254)
		);
	} catch {
		return false;
	}
}

export function redactEndpoint(endpoint: string | undefined): string {
	if (!endpoint) return t("unknown");
	try {
		const url = new URL(endpoint);
		url.username = "";
		url.password = "";
		for (const key of url.searchParams.keys()) {
			if (secretName(key)) url.searchParams.set(key, "[REDACTED]");
		}
		return redact(url.toString()) as string;
	} catch {
		return redact(endpoint) as string;
	}
}

function serialize(value: unknown): string {
	return JSON.stringify(redact(value), null, 2) ?? "null";
}

class RequestReader implements Component {
	private top = 0;
	private readonly lines: string[];
	/** The lines wrapped to the last render width, so no line is wider than the terminal. */
	private wrapped: string[] = [];
	private wrappedWidth = 0;
	private readonly height: () => number;
	private readonly close: () => void;
	private readonly renderRequest: () => void;

	constructor(text: string, height: () => number, close: () => void, renderRequest: () => void) {
		this.lines = text.split("\n");
		this.height = height;
		this.close = close;
		this.renderRequest = renderRequest;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width !== this.wrappedWidth) {
			this.wrapped = this.lines.flatMap((line) => wrapTextWithAnsi(line, width));
			this.wrappedWidth = width;
		}
		const body = Math.max(3, this.height() - 2);
		this.top = Math.max(0, Math.min(this.top, this.wrapped.length - body));
		const end = Math.min(this.wrapped.length, this.top + body);
		return [
			truncateToWidth(theme.bold(theme.fg("accent", t("Last model request"))), width),
			...this.wrapped.slice(this.top, end),
			truncateToWidth(theme.fg("dim", t("↑↓ scroll · PgUp/PgDn page · Esc close")), width),
		];
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		const page = Math.max(1, this.height() - 4);
		if (keys.matches(data, "tui.select.cancel")) {
			this.close();
			return;
		}
		if (keys.matches(data, "tui.select.up")) this.top--;
		else if (keys.matches(data, "tui.select.down")) this.top++;
		else if (keys.matches(data, "tui.select.pageUp")) this.top -= page;
		else if (keys.matches(data, "tui.select.pageDown")) this.top += page;
		else return;
		this.renderRequest();
	}
}

export function requestReport(context: ExtensionContext): Record<string, unknown> {
	if (!lastRequest) return { message: t("No model request has been captured in this session.") };
	const request = lastRequest;
	return redact({
		correlationId: request.correlationId,
		provider: request.provider,
		endpoint: redactEndpoint(request.endpoint),
		model: request.model,
		sessionEntries: context.sessionManager.getEntries(),
		preparedPrompt: request.prepared,
		providerPayload: request.payload ?? "No onPayload callback was reached.",
		response: request.responseReceived ? "received" : "not received yet",
		limitations: t(
			"The provider may serialize, rewrite, truncate, cache, or otherwise transform this payload; server-side behavior and OAuth/subscription rewriting cannot be verified here.",
		),
	}) as Record<string, unknown>;
}

export function serializeRequestExport(context: ExtensionContext): string {
	return `${JSON.stringify(requestReport(context), null, 2)}\n`;
}

/** The terminal and graphical export share masking, exclusive creation and private file permissions. */
export function exportRequest(context: ExtensionContext, target: string): string {
	if (!target.trim()) throw new Error(t("Usage: /sent export <path>"));
	if (!lastRequest) throw new Error(t("No model request has been captured in this session."));
	const path = resolveToCwd(target.trim(), context.cwd);
	writeFileSync(path, serializeRequestExport(context), { flag: "wx", mode: 0o600 });
	return path;
}

function report(context: ExtensionContext): string {
	const data = requestReport(context);
	if ("message" in data) return String(data.message);
	const section = (title: string, body: unknown) => `## ${t(title)}\n${serialize(body)}`;
	return [
		`# ${fill("Request #{0}", String(data.correlationId))}`,
		`\n${t("Provider")}: ${data.provider}\n${t("Endpoint")}: ${data.endpoint}\n${t("Model")}: ${data.model}\n${t("Provider response")}: ${t(data.response === "received" ? "received" : "not received yet")}`,
		section("Session entries (session context; not sent as-is)", data.sessionEntries),
		section("Prepared prompt (reconstruction)", data.preparedPrompt),
		section("Provider payload at onPayload (captured exactly before transport serialization)", data.providerPayload),
		`\n${data.limitations}`,
	].join("\n\n");
}

export default function requestInspector(pi: ExtensionAPI): void {
	// fork: the capture belongs to its session; /sent in the next one must not show it.
	// A reload keeps the same session, and its request.
	pi.on("session_shutdown", (event) => {
		if (event.reason !== "reload") lastRequest = undefined;
	});
	pi.on("before_provider_request", (_event, context) => {
		const endpoint = context.model?.baseUrl;
		if (!endpoint) return;
		const local = isLocalEndpoint(endpoint);
		if (previousWasLocal === true && !local && cloudWarningEnabled) {
			context.ui.setStatus("request-inspector-cloud", t("This request will be sent to a cloud model."));
		}
		previousWasLocal = local;
	});
	pi.on("after_provider_response", (_event, context) => context.ui.setStatus("request-inspector-cloud", undefined));
	pi.registerCommand("sent", {
		description: t("Inspect the last model request: /sent, /sent export <path>"),
		handler: async (args, context) => {
			if (args?.startsWith("export ")) {
				const target = args.slice("export ".length).trim();
				if (!target) return context.ui.notify(t("Usage: /sent export <path>"), "error");
				if (!lastRequest)
					return context.ui.notify(t("No model request has been captured in this session."), "warning");
				try {
					const path = exportRequest(context, target);
					context.ui.notify(`${t("Redacted request exported to")} ${path}`);
				} catch (error) {
					context.ui.notify(
						`${t("Could not export request")}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				return;
			}
			if (args?.trim()) return context.ui.notify(t("Usage: /sent [export <path>]"), "error");
			if (!context.hasUI) return context.ui.notify(report(context));
			await context.ui.custom<void>(
				(tui, _theme, _keys, done) =>
					new RequestReader(
						report(context),
						() => Math.floor(tui.terminal.rows * 0.75),
						() => done(undefined),
						() => tui.requestRender(),
					),
				{ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%" } },
			);
		},
	});
}
