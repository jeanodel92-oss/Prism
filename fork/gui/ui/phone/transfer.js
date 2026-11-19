// Files between the phone and the PC. The engine runs on the PC, so a file
// the user picks on the phone has to travel to it before it can be attached, and a file the PC made has to travel back
// before the phone can open or keep it. Both go in pieces over the link, never as one line.
//
// Phone to PC: the pieces go to the PC (`upload_*`), which keeps the file in a private folder; `attach_picked` then
// attaches it as the window attaches a file its picker returned. PC to phone: the engine's `files_read` gives the pieces,
// the host assembles them in the app's cache (`download_*`), and the Android activity saves or opens the result.

import { t } from "../js/i18n.js";

/** The most the PC takes or gives (fork/android/link/src/files.rs MAX_FILE). */
export const MAX_FILE = 100 * 1024 * 1024;
/** The size of one piece sent to the PC (the PC takes up to 4 MiB). */
export const PIECE = 3 * 1024 * 1024;

export function base64(bytes) {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

const host = () => globalThis.__TAURI__.core.invoke;

/**
 * Sends `file` to the PC and returns its path there, ready for `attach_picked`. A file above the bound is refused
 * before a byte leaves, and a piece that fails ends the upload on the PC too.
 */
export async function uploadToPc(file, invoke = host()) {
	if (file.size > MAX_FILE) throw new Error(t("phoneAttachTooBig", file.name, MAX_FILE / 1024 / 1024));
	const { upload } = await invoke("upload_start", { name: file.name || "file", size: file.size });
	try {
		for (let at = 0; at < file.size; at += PIECE) {
			const bytes = new Uint8Array(await file.slice(at, Math.min(at + PIECE, file.size)).arrayBuffer());
			await invoke("upload_chunk", { upload, data: base64(bytes) });
		}
		return (await invoke("upload_finish", { upload })).path;
	} catch (error) {
		await invoke("upload_cancel", { upload }).catch(() => {});
		throw error;
	}
}

/**
 * Brings a file of the PC to the phone and returns its name. `request` is the session's engine request (`files_read`),
 * which refuses what the files screen would; `open` shows the file in the app that opens it, else it is saved in the
 * phone's Downloads. The pieces are checked against each other: a file that changes on the PC meanwhile is refused.
 */
export async function downloadFromPc({ request, path, open = false, invoke = host(), android = globalThis.PrismAndroid }) {
	if (!android?.saveDownload) throw new Error(t("downloadNoPhone"));
	let piece = await request({ type: "files_read", path, offset: 0 });
	const first = piece;
	const id = await invoke("download_begin", { name: first.name });
	try {
		let received = 0;
		for (;;) {
			await invoke("download_append", { id, data: piece.data });
			received += piece.length;
			if (piece.eof) break;
			if (piece.length === 0) throw new Error(t("downloadChanged", first.name));
			piece = await request({ type: "files_read", path, offset: received });
			if (piece.size !== first.size || piece.mtimeMs !== first.mtimeMs) throw new Error(t("downloadChanged", first.name));
		}
		if (received !== first.size) throw new Error(t("downloadChanged", first.name));
		const local = await invoke("download_finish", { id });
		const problem = android.saveDownload(local, first.name, open);
		if (problem) throw new Error(problem);
		return first.name;
	} catch (error) {
		await invoke("download_discard", { id }).catch(() => {});
		throw error;
	}
}

/**
 * What an export (a report, `request_export`, `doctor_export`) does on the phone: the file the PC wrote is brought to
 * the phone's Downloads. On the desktop window, nothing: the user is on the PC and reads the path.
 */
export async function keepExport(view, path) {
	if (!view.app.info?.remote) return;
	try {
		const name = await downloadFromPc({ request: (command) => view.engine.request(command), path });
		view.app.toast(t("downloadSaved", name));
	} catch (error) {
		view.app.toast(String(error?.message ?? error), "error");
	}
}
