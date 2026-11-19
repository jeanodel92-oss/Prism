// The user chooses a folder before sending work; this is host UI, never a model filesystem operation.
import { ListBox, Panel } from "./components.js";
import { h } from "./dom.js";
import { t } from "./i18n.js";

const { invoke } = window.__TAURI__.core;

export async function projectScreen(view) {
	const panel = new Panel({ title: t("chooseProject"), kind: "project" });
	const path = h("input", { class: "field", value: view.cwd, "aria-label": t("folder"), dataset: { autofocus: "" } });
	const error = h("p", { class: "panel-text", role: "alert" });
	let request = 0;
	let closed = false;
	const expand = (value) => value === "~" ? view.app.info.home : value.startsWith("~/") ? `${view.app.info.home}/${value.slice(2)}` : value;
	const list = new ListBox({ onChoose: (item) => browse(item.value), empty: t("noFolders") });
	const browse = async (value = path.value) => {
		const id = ++request;
		try {
			const found = await invoke("project_directory", { path: expand(value) });
			if (closed || id !== request) return;
			path.value = found.path;
			error.textContent = "";
			list.setItems([
				...(found.parent ? [{ label: "..", value: found.parent }] : []),
				...found.folders.map((label) => ({ label, value: `${found.path}/${label}` })),
			]);
			return found;
		} catch (problem) {
			if (!closed && id === request) error.textContent = String(problem?.message ?? problem);
		}
	};
	const open = h("button", {
		type: "button", class: "primary", text: t("openProject"),
		onclick: async () => {
			open.disabled = true;
			const chosen = await browse();
			open.disabled = false;
			if (!closed && chosen) panel.done(chosen.path);
		},
	});
	// Browse opens the system's folder picker; Enter in the field still lists the typed path.
	// On the phone there is no picker for the PC's folders: only the field and the list of the folder typed.
	const pick = h("button", {
		type: "button", text: t("browse"),
		onclick: async () => {
			pick.disabled = true;
			try {
				const picked = await invoke("pick_folder", { start: expand(path.value) });
				if (picked && !closed) await browse(picked);
			} catch (problem) {
				if (!closed) error.textContent = String(problem?.message ?? problem);
			} finally {
				pick.disabled = false;
			}
		},
	});
	// the folders worked in lately, one click away, read from the saved sessions.
	const { folders: recent = [] } = await view.engine.request({ type: "recent_projects" }).catch(() => ({}));
	const home = view.app.info.home;
	const recentList = new ListBox({
		// The folder's name first, which a long path would cut off; its place below.
		items: recent.map((folder) => ({
			label: folder.slice(folder.lastIndexOf("/") + 1) || folder,
			description: home && folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder,
			value: folder,
		})),
		onChoose: (item) => panel.done(item.value),
	});
	recentList.el.classList.add("project-recent");
	panel.setBody(
		...(recent.length ? [h("h3", { class: "perm-heading", text: t("recentProjects") }), recentList.el] : []),
		h("form", { class: "project-path", onsubmit: (event) => { event.preventDefault(); browse(); } }, path, !view.app.info.remote && pick),
		error,
		list.el,
	);
	panel.setActions(open);
	await browse();
	let chosen;
	try {
		chosen = await view.showPanel("project", panel);
	} finally {
		closed = true;
	}
	if (chosen) await view.app.openSession(undefined, undefined, chosen);
}
