// "Link a phone" in the PC window: Prism starts its phone
// server, while the window is open or always as a service, and shows the pairing code as a QR image, as text to copy,
// with the addresses the phone will try (Tailscale first when it is up, the local network otherwise). The linked phones
// are listed, each can be revoked. The host commands are the window's (src-tauri/src/phone_link.rs); the phone app has
// none of them, so nothing here shows there.

import { ANDROID_APP_URL, androidAppQr, openAndroidApp } from "./android-app.js";
import { Panel } from "./components.js";
import { copyText, h } from "./dom.js";
import { t } from "./i18n.js";

const { invoke } = window.__TAURI__.core;

const TAILSCALE_DOWNLOAD = "https://tailscale.com/download/linux";
const message = (error) => String(error?.message ?? error);

/** The server's state, or undefined where the window has no such commands (the phone app). */
export async function phoneLinkState() {
	try {
		return await invoke("phone_link_state");
	} catch {
		return undefined;
	}
}

/** Tailscale's addresses are in 100.64.0.0/10. */
export function isTailscale(host) {
	const [a, b] = String(host).split(".").map(Number);
	return a === 100 && b >= 64 && b < 128;
}

/** The linked phones, one row each with a revoke button; a short line when there are none. Shared by the panel and the settings. */
export function phonesList(paired, { busy = false, onRevoke }) {
	if (!paired.length) return h("p", { class: "panel-text muted", text: t("phoneLinkNoPhone") });
	return h(
		"ul",
		{ class: "link-phone-phones" },
		...paired.map((fingerprint) =>
			h("li", {}, h("code", { title: fingerprint, text: `${fingerprint.slice(0, 16)}…` }), h("button", { type: "button", class: "ghost", text: t("phoneLinkRevoke"), disabled: busy, onclick: () => onRevoke(fingerprint) })),
		),
	);
}

/** Revokes a phone by its fingerprint (the host refuses anything but a full fingerprint). */
export const revokePhone = (fingerprint) => invoke("phone_link_revoke", { fingerprint });

/** The panel; resolves when it closes. */
export async function phoneLinkScreen(view) {
	const panel = new Panel({ title: t("phoneLinkTitle"), kind: "report link-phone" });
	let state = await phoneLinkState();
	let invitation;
	let problem = "";
	let busy = false;

	const act = async (work) => {
		busy = true;
		problem = "";
		draw();
		try {
			await work();
		} catch (error) {
			problem = message(error);
		} finally {
			busy = false;
			state = await phoneLinkState();
			draw();
		}
	};
	const invite = () =>
		act(async () => {
			invitation = await invoke("phone_link_invite");
		});
	const start = (mode) =>
		act(async () => {
			await invoke("phone_link_start", { mode });
			invitation = await invoke("phone_link_invite");
		});

	const serverPart = () => {
		if (!state?.available) return [h("p", { class: "panel-text", text: t("phoneLinkMissing") })];
		const running = Boolean(state.server);
		const how = state.mode === "service" ? t("phoneLinkModeService") : state.mode === "window" ? t("phoneLinkModeWindow") : t("phoneLinkModeOther");
		return [
			h("h3", { class: "link-phone-heading", text: t("phoneLinkServer") }),
			h("p", { class: "panel-text", text: running ? how : t("phoneLinkStopped") }),
			h(
				"div",
				{ class: "link-phone-row" },
				state.mode !== "window" && h("button", { type: "button", class: running ? "" : "primary", text: t("phoneLinkStartWindow"), disabled: busy, onclick: () => start("window") }),
				state.mode !== "service" && h("button", { type: "button", text: t("phoneLinkStartService"), disabled: busy, onclick: () => start("service") }),
				running && state.mode && h("button", { type: "button", class: "ghost", text: t("phoneLinkStop"), disabled: busy, onclick: () => act(() => invoke("phone_link_stop")) }),
			),
			h("p", { class: "panel-text muted", text: t("phoneLinkModesHelp") }),
		];
	};

	const networkPart = () => {
		const hosts = state?.server?.hosts ?? [];
		const lines = hosts.map((host) => h("li", {}, h("span", { class: "link-phone-host", text: host }), h("span", { class: "muted", text: isTailscale(host) ? t("phoneLinkTailscale") : t("phoneLinkLocal") })));
		const tailscale = state?.tailscale ?? {};
		const hint = !tailscale.installed
			? h("p", { class: "panel-text" }, t("phoneLinkNoTailscale"), " ", h("button", { type: "button", class: "ghost", text: t("phoneLinkInstallTailscale"), onclick: () => invoke("open_external", { url: TAILSCALE_DOWNLOAD }).catch(() => {}) }))
			: !tailscale.address
				? h("p", { class: "panel-text", text: t("phoneLinkTailscaleDown") })
				: undefined;
		// fork: ufw, on by default on CachyOS, dropped the phone at home and nothing said so.
		const firewall = state?.server?.firewall;
		const blocked = firewall
			? h("div", { class: "panel-text", role: "note" }, h("p", { text: t(firewall.certain ? "phoneLinkFirewall" : "phoneLinkFirewallMaybe", firewall.name, state.server.port) }), h("code", { class: "link-phone-host", text: firewall.command }))
			: undefined;
		return [h("h3", { class: "link-phone-heading", text: t("phoneLinkNetwork") }), lines.length ? h("ul", { class: "link-phone-hosts" }, ...lines) : undefined, hint, blocked];
	};

	const codePart = () => {
		if (!state?.server) return [];
		const parts = [h("h3", { class: "link-phone-heading", text: t("phoneLinkCode") })];
		if (invitation?.code) {
			const field = h("textarea", { class: "field link-phone-code", rows: "3", readonly: true, spellcheck: "false", "aria-label": t("phoneLinkCode") });
			field.value = invitation.code;
			parts.push(
				h(
					"div",
					{ class: "link-phone-pair" },
					h("img", { class: "link-phone-qr", alt: t("phoneLinkQrAlt"), src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(invitation.svg)}` }),
					h(
						"div",
						{ class: "link-phone-text" },
						h("p", { class: "panel-text", text: t("phoneLinkScan") }),
						field,
						h(
							"div",
							{ class: "link-phone-row" },
							h("button", { type: "button", text: t("phoneLinkCopy"), onclick: async () => { if (await copyText(invitation.code)) view.app.toast(t("phoneLinkCopied")); } }),
							h("button", { type: "button", class: "ghost", text: t("phoneLinkNewCode"), disabled: busy, onclick: invite }),
						),
					),
				),
			);
		} else parts.push(h("button", { type: "button", class: "primary", text: t("phoneLinkNewCode"), disabled: busy, onclick: invite }));
		return parts;
	};

	// The app itself, for a phone that has none yet: its download as a QR code for the phone's own camera.
	const appQr = await androidAppQr();
	const appPart = () => [
		h("h3", { class: "link-phone-heading", text: t("phoneAppTitle") }),
		h(
			"div",
			{ class: "link-phone-pair" },
			appQr && h("img", { class: "link-phone-qr small", alt: t("phoneAppQrAlt"), src: appQr }),
			h(
				"div",
				{ class: "link-phone-text" },
				h("p", { class: "panel-text", text: t("phoneAppHelp") }),
				h("code", { class: "link-phone-host", text: ANDROID_APP_URL }),
				h("div", { class: "link-phone-row" }, h("button", { type: "button", class: "ghost", text: t("phoneAppOpen"), onclick: openAndroidApp })),
			),
		),
	];

	const phonesPart = () => [
		h("h3", { class: "link-phone-heading", text: t("phoneLinkPhones") }),
		phonesList(state?.paired ?? [], { busy, onRevoke: (fingerprint) => act(() => revokePhone(fingerprint)) }),
	];

	function draw() {
		const body = h("div", { class: "link-phone" });
		body.append(
			// The code first: it is what the user opened this for.
			...[...serverPart(), ...codePart(), ...(state?.server ? networkPart() : []), ...appPart(), ...(state?.available ? phonesPart() : [])].filter(Boolean),
			...(problem ? [h("p", { class: "pair-error", role: "alert", text: problem })] : []),
		);
		panel.setBody(body);
	}

	// A running server: a code straight away, as the user opened this to link a phone.
	if (state?.server) {
		try {
			invitation = await invoke("phone_link_invite");
		} catch (error) {
			problem = message(error);
		}
	}
	draw();
	await view.showPanel("phone-link", panel);
}
