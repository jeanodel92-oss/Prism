// The phone's pairing screen: the app shows Prism's window for a PC it is linked to. Until the
// phone is paired and connected there is no engine to talk to, so this screen takes the place of the window; once linked,
// the same panel sits in the window's settings to see the PC's name, link another one or forget it. The host commands
// exist in the phone app only: on the desktop window `link_status` rejects and nothing here shows.

import { canCheckUpdates, updatePanel } from "./android-update.js";
import { openAndroidApp } from "./android-app.js";
import { clear, h } from "./dom.js";
import { t } from "./i18n.js";

const { invoke } = window.__TAURI__.core;

/** The link's state `{paired, connected, host, error}`, or undefined where there is no link (the desktop window). */
export async function linkStatus() {
	try {
		return await invoke("link_status");
	} catch {
		return undefined;
	}
}

const message = (error) => String(error?.message ?? error);

/** The transport's `error_kind` (fork/android/phone, `ErrorKind`) and the text that says it. */
const ERROR_TEXT = {
	not_linked: "pairErrorNotLinked",
	revoked: "pairErrorRevoked",
	lost: "pairErrorLost",
	refused: "pairErrorRefused",
	timeout: "pairErrorTimeout",
	unreachable: "pairErrorUnreachable",
	code_refused: "pairErrorCodeRefused",
	code_invalid: "pairErrorCodeInvalid",
	other_pc: "pairErrorOtherPc",
};

/**
 * The link's error in the user's language, the raw one ("…: Connection refused (os error 111)") folded under Details;
 * undefined without an error. An error the transport cannot name shows as it is.
 */
function linkError(status, className) {
	if (!status?.error) return undefined;
	const key = ERROR_TEXT[status.error_kind];
	if (!key) return h("span", { class: className, text: status.error });
	return h(
		"span",
		{ class: className },
		h("span", { text: t(key) }),
		h("details", { class: "pair-details" }, h("summary", { text: t("pairErrorDetails") }), h("code", { text: status.error })),
	);
}

/** The Prism mark, the site's favicon drawn in the text colour. */
function prismMark() {
	const SVG = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(SVG, "svg");
	svg.setAttribute("viewBox", "0 0 32 32");
	svg.setAttribute("class", "pair-mark");
	svg.setAttribute("aria-hidden", "true");
	for (const d of ["M16 6.5 26.5 25H5.5Z", "M2.5 19.2h7.6"]) {
		const path = document.createElementNS(SVG, "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	return svg;
}

/**
 * The camera, opened by its button only: the barcode scanner plugin draws the camera
 * behind the page, which turns transparent but for a frame, a hint and Cancel. Resolves to the QR code's text, or
 * undefined when the user cancelled. The overlay is a modal dialog of its own: started from the settings (a modal
 * dialog), an overlay outside it was inert, so Cancel did nothing.
 */
async function scanCode() {
	const permission = await invoke("plugin:barcode-scanner|request_permissions");
	if (permission?.camera !== "granted") throw new Error(t("pairCameraDenied"));
	const cancel = h("button", { type: "button", text: t("cancel"), onclick: () => invoke("plugin:barcode-scanner|cancel").catch(() => {}) });
	const overlay = h(
		"dialog",
		{ class: "scan-overlay", "aria-label": t("pairScan") },
		h("div", { class: "scan-frame", "aria-hidden": "true" }),
		h("p", { class: "scan-hint", text: t("pairScanHint") }),
		h("div", { class: "scan-actions" }, cancel),
	);
	document.documentElement.classList.add("scanning");
	document.body.append(overlay);
	overlay.showModal();
	// Escape (a keyboard) cancels as the button does, instead of closing the dialog under a running scan.
	overlay.addEventListener("cancel", (event) => {
		event.preventDefault();
		invoke("plugin:barcode-scanner|cancel").catch(() => {});
	});
	// Android's back button cancels, as the button does, instead of leaving the app. A capture listener runs before the
	// phone's own (phone.js), which would read it as a way home; it also takes the entry this removes once done.
	let scanning = true;
	const back = (event) => {
		event.stopImmediatePropagation();
		if (scanning) invoke("plugin:barcode-scanner|cancel").catch(() => {});
		else window.removeEventListener("popstate", back, true);
	};
	history.pushState({ scanning: true }, "");
	window.addEventListener("popstate", back, true);
	try {
		const result = await invoke("plugin:barcode-scanner|scan", { windowed: true, formats: ["QR_CODE"] });
		return result?.content;
	} catch (error) {
		if (message(error) === "cancelled") return undefined;
		throw error;
	} finally {
		scanning = false;
		if (history.state?.scanning) history.back();
		else window.removeEventListener("popstate", back, true);
		overlay.close();
		overlay.remove();
		document.documentElement.classList.remove("scanning");
	}
}

/** The pairing form and the paired PC's state, drawn from `status`. */
function pairPanel(status, { retry } = {}) {
	let busy = false;
	const code = h("textarea", {
		class: "field pair-code",
		rows: "3",
		spellcheck: "false",
		autocomplete: "off",
		autocapitalize: "off",
		// The keyboard otherwise "corrects" a typed code: "prism-pair: V1". The transport
		// also drops spaces and capitals from the code (fork/android/phone, `normalize_code`).
		autocorrect: "off",
		inputmode: "url",
		placeholder: "prism-pair:v1;…",
		"aria-label": t("pairCode"),
	});
	const problem = h("p", { class: "pair-error", role: "alert", hidden: true });
	const say = (text) => {
		problem.replaceChildren(text ?? "");
		problem.hidden = !text;
	};
	const link = h("button", { type: "button", class: "primary", text: t("pairLink") });
	const scan = h("button", { type: "button", text: t("pairScan") });
	const forget = h("button", { type: "button", text: t("pairForget") });
	const lock = (on) => {
		busy = on;
		link.disabled = on;
		scan.disabled = on;
		forget.disabled = on;
		code.disabled = on;
	};
	scan.addEventListener("click", async () => {
		if (busy) return;
		say("");
		lock(true);
		let text;
		try {
			text = await scanCode();
		} catch (error) {
			say(message(error));
		}
		lock(false);
		if (!text) return;
		if (!text.startsWith("prism-pair:")) return say(t("pairNotPrism"));
		code.value = text;
		link.click();
	});
	link.addEventListener("click", async () => {
		// A code copied from the terminal, where /phone wraps it, comes with line breaks: a code has no whitespace.
		const text = code.value.replace(/\s+/g, "");
		if (busy) return;
		if (!text) return say(t("pairEmpty"));
		say("");
		lock(true);
		try {
			await invoke("link_pair", { code: text });
			// The window's state (engine, sessions, themes) is read once at startup: a fresh start is the simplest correct way.
			location.reload();
		} catch (error) {
			// The status holds the same error, with its kind.
			say(linkError(await linkStatus(), "pair-error-text") ?? message(error));
			lock(false);
		}
	});
	forget.addEventListener("click", async () => {
		if (busy) return;
		lock(true);
		try {
			await invoke("link_forget");
			location.reload();
		} catch (error) {
			say(message(error));
			lock(false);
		}
	});

	const state = status.paired
		? h(
				"div",
				{ class: "pair-state" },
				h("strong", { class: "pair-host", text: status.host ?? t("pairUnnamed") }),
				h("span", { class: "pair-note", text: status.connected ? t("pairConnected") : t("pairNotConnected") }),
				!status.connected && linkError(status, "pair-note pair-failed"),
			)
		: undefined;
	// The other PCs this phone is paired with, one button away.
	const others = h("div", { class: "pair-known", hidden: true });
	invoke("link_known")
		.then((known) => {
			const rows = (known ?? []).filter((pc) => !pc.current);
			if (rows.length === 0) return;
			others.append(
				h("p", { class: "pair-help", text: t("pairKnown") }),
				...rows.map((pc) =>
					h(
						"div",
						{ class: "pair-known-row" },
						h("span", { class: "pair-host", text: pc.name ?? pc.host ?? t("pairUnnamed") }),
						h("button", {
							type: "button",
							text: t("pairUse"),
							onclick: async () => {
								if (busy) return;
								lock(true);
								try {
									await invoke("link_switch", { id: pc.id });
									location.reload();
								} catch (error) {
									say(message(error));
									lock(false);
								}
							},
						}),
					),
				),
			);
			others.hidden = false;
		})
		.catch(() => {});

	// A failure of the link itself (no PC yet, or the PC unreachable) is said once, whether or not a PC is paired.
	if (!status.paired && status.error) say(linkError(status, "pair-error-text"));

	return h(
		"div",
		{ class: "pair-panel" },
		state,
		others,
		h("p", { class: "pair-help", text: status.paired ? t("pairHelpAnother") : t("pairHelp") }),
		h("label", { class: "pair-label", text: t("pairCode") }, code),
		problem,
		h("div", { class: "pair-actions" }, scan, link, status.paired && retry && h("button", { type: "button", text: t("pairRetry"), onclick: retry }), status.paired && forget),
	);
}

/** Takes the window's place while the phone is not linked. Nothing leaves it but a reload. */
export function showPairScreen(status) {
	const screen = h(
		"div",
		{ class: "pair-screen", id: "pair-screen", role: "dialog", "aria-modal": "true", "aria-labelledby": "pair-title" },
		h(
			"main",
			{ class: "pair-card" },
			h("div", { class: "pair-brand" }, prismMark(), h("span", { class: "pair-brand-name", text: "Prism" })),
			h("p", { class: "pair-tagline", text: t("pairTagline") }),
			h("h1", { id: "pair-title", text: t("pairTitle") }),
			pairPanel(status, { retry: () => location.reload() }),
		),
	);
	document.body.append(screen);
	screen.querySelector("textarea")?.focus({ preventScroll: true });
	return screen;
}

/**
 * a notice with one action on the pairing screen, which covers the toasts; false when it is not shown.
 * An app too old for its PC lands here, so a newer version is said here too.
 */
export function pairScreenNotice(text, action) {
	const card = document.querySelector("#pair-screen .pair-card");
	if (!card) return false;
	card.append(
		h(
			"div",
			{ class: "pair-update" },
			h("p", { class: "pair-note", text }),
			h("div", { class: "pair-actions" }, h("button", { type: "button", class: "primary", text: action.label, onclick: action.run })),
		),
	);
	return true;
}

/**
 * fork: the permanent notification that keeps the link to the PC up while the app is in
 * the background (fork/android/android/LinkService.kt), on unless turned off here. Only in the Android app.
 */
function keepLinkSwitch() {
	const android = window.PrismAndroid;
	if (!android?.setKeepLink) return undefined;
	const box = h("input", { type: "checkbox", class: "pair-keep-box" });
	box.checked = android.keepLinkEnabled();
	box.addEventListener("change", () => android.setKeepLink(box.checked));
	return h(
		"label",
		{ class: "pair-keep" },
		box,
		h("span", {}, h("span", { class: "pair-keep-title", text: t("pairKeepLink") }), h("span", { class: "pair-note", text: t("pairKeepLinkHelp") })),
	);
}

/**
 * The panel in the settings' Window section (index.html `#settings-link`): it shows when the app is linked, and keeps the
 * PC's name and a way to forget it. Returns the function that draws it again, for a change of language.
 */
export function mountLinkSettings(host, status) {
	const draw = () => {
		clear(host);
		host.append(
			h("h3", { class: "pair-heading", text: t("pairSettings") }),
			pairPanel(status),
			keepLinkSwitch(),
			// the update mode and a check (android-update.js); the download opens in the phone's browser.
			canCheckUpdates()
				? updatePanel()
				: h("div", { class: "pair-actions pair-update" }, h("button", { type: "button", text: t("pairUpdateApp"), onclick: openAndroidApp })),
		);
	};
	host.hidden = false;
	draw();
	return draw;
}
