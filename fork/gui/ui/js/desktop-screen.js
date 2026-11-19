// the agent's own desktop, live, in the window (/desktop). The engine captures it on request
// (rpc-builtins.ts, desktop_frame) and never starts it for this view; the next picture is asked once the last one
// arrived, so a slow capture never piles requests up. The capture leaves the cursor out: the agent's pointer is
// drawn where the agent last put it.

import { Panel } from "./components.js";
import { h } from "./dom.js";
import { t } from "./i18n.js";

/** Between two pictures while the desktop runs, and between two looks while it does not. */
// A picture costs about 30 ms at 1280x720: some 7 a second at most.
const LIVE_MS = 100;
const IDLE_MS = 2000;

export async function desktopScreen(view) {
	const panel = new Panel({ title: t("desktopTitle"), kind: "report desktop" });
	const image = h("img", { class: "desktop-frame", alt: t("desktopAlt") });
	const pointer = h("span", { class: "desktop-pointer", "aria-hidden": "true" });
	const stage = h("div", { class: "desktop-stage" }, image, pointer);
	const note = h("p", { class: "panel-text muted", text: t("desktopNotRunning") });
	let running = false;
	let stopping = false;
	let closed = false;
	let asking = false;
	let timer;

	const drawActions = () =>
		panel.setActions(
			running &&
				h("button", {
					type: "button",
					text: stopping ? t("desktopStopping") : t("desktopStop"),
					disabled: stopping,
					onclick: stop,
				}),
		);
	const draw = (frame) => {
		running = frame.running;
		stage.hidden = !running;
		note.hidden = running;
		if (running) {
			image.src = `data:${frame.mimeType};base64,${frame.data}`;
			panel.setTitle(t("desktopTitle"), `${frame.width}×${frame.height}`);
			pointer.hidden = !frame.pointer;
			if (frame.pointer) {
				pointer.style.left = `${(frame.pointer.x / frame.width) * 100}%`;
				pointer.style.top = `${(frame.pointer.y / frame.height) * 100}%`;
			}
		} else {
			panel.setTitle(t("desktopTitle"));
			image.removeAttribute("src");
		}
		drawActions();
	};
	const look = () => view.engine.request({ type: "desktop_frame" }).catch(() => ({ running: false }));
	// One request at a time: a refresh asked during another one leaves the next to it.
	const refresh = async () => {
		clearTimeout(timer);
		if (asking) return;
		asking = true;
		try {
			// Another conversation in front: nothing to draw, nothing asked.
			if (panel.el.isConnected) draw(await look());
		} finally {
			asking = false;
		}
		if (!closed) timer = setTimeout(refresh, running ? LIVE_MS : IDLE_MS);
	};
	async function stop() {
		stopping = true;
		drawActions();
		try {
			await view.engine.request({ type: "desktop_stop" });
		} finally {
			stopping = false;
			if (!closed) await refresh();
		}
	}

	panel.setBody(h("div", { class: "desktop-layout" }, note, stage));
	draw(await look());
	timer = setTimeout(refresh, running ? LIVE_MS : IDLE_MS);
	try {
		await view.showPanel("desktop", panel);
	} finally {
		closed = true;
		clearTimeout(timer);
	}
}
