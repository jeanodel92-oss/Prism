// One open session = one engine process in RPC mode. This module only carries messages: it sends
// commands, matches responses to requests by id, and hands every other line, in order, to the view.

import { t } from "./i18n.js";

const { invoke, Channel } = window.__TAURI__.core;

let nextRequest = 0;
/** The engine's technical output kept for the side menu's logs (side-menu.js): its last lines only. */
const OUTPUT_LINES = 500;

export class Engine {
	constructor(onEvent, onExit) {
		this.id = undefined;
		this.pending = new Map();
		this.onEvent = onEvent;
		this.onExit = onExit;
		this.alive = false;
		/** The engine's stderr, secrets masked by the host (engine.rs), and who wants to know when it grows. */
		this.output = [];
		this.onOutput = undefined;
	}

	/** `resume`: on the phone, the engine the PC kept after the link was cut (fork/android/server); the window has none. */
	async start(sessionPath, cwd, resume) {
		const channel = new Channel();
		channel.onmessage = (message) => this.#receive(message);
		this.id = await invoke("engine_start", { session: sessionPath ?? null, cwd: cwd ?? null, resume: resume ?? null, onMessage: channel });
		this.alive = true;
	}

	#receive(message) {
		if (message.kind === "stderr") {
			this.output.push(message.line);
			if (this.output.length > OUTPUT_LINES) this.output.splice(0, this.output.length - OUTPUT_LINES);
			this.onOutput?.();
			return;
		}
		if (message.kind === "exit") {
			this.alive = false;
			for (const { reject } of this.pending.values()) reject(new Error(t("engineGone")));
			this.pending.clear();
			this.onExit(message);
			return;
		}
		let record;
		try {
			record = JSON.parse(message.line);
		} catch {
			return; // Not protocol output (a stray log line): ignored, never rendered as content.
		}
		if (record.type === "response" && typeof record.id === "string" && this.pending.has(record.id)) {
			const { resolve, reject } = this.pending.get(record.id);
			this.pending.delete(record.id);
			if (record.success) resolve(record.data);
			else reject(new Error(record.error || t("requestFailed")));
			return;
		}
		this.onEvent(record);
	}

	/** The questions a kept engine still waits an answer to, sent again as its events (phone only). */
	replay() {
		return invoke("engine_replay", { engine: this.id });
	}

	send(record) {
		if (!this.alive) return Promise.reject(new Error(t("engineGone")));
		return invoke("engine_send", { engine: this.id, line: JSON.stringify(record) });
	}

	request(command) {
		const id = `gui-${++nextRequest}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.send({ ...command, id }).catch((error) => {
				this.pending.delete(id);
				reject(error);
			});
		});
	}

	/** Files the picker returned or a drop gave, attached by the engine; the window's host sends the command (attach.rs). */
	attachPicked(paths) {
		if (!this.alive) return Promise.reject(new Error(t("engineGone")));
		const id = `gui-${++nextRequest}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			invoke("attach_picked", { engine: this.id, id, paths }).catch((error) => {
				this.pending.delete(id);
				reject(error);
			});
		});
	}

	answer(dialogId, response) {
		return this.send({ type: "extension_ui_response", id: dialogId, ...response });
	}

	async stop() {
		if (this.id !== undefined && this.alive) await invoke("engine_stop", { engine: this.id });
	}
}
