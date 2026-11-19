// Small DOM helpers. Text always goes in through textContent: nothing from the engine or the model is
// ever parsed as HTML.

export function h(tag, attrs = {}, ...children) {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (value === undefined || value === null || value === false) continue;
		if (key === "class") el.className = value;
		else if (key === "text") el.textContent = value;
		else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
		else if (key === "dataset") Object.assign(el.dataset, value);
		// The window's CSP (style-src 'self') ignores a style attribute; properties set through the DOM apply.
		else if (key === "style")
			for (const declaration of String(value).split(";")) {
				const at = declaration.indexOf(":");
				if (at > 0) el.style.setProperty(declaration.slice(0, at).trim(), declaration.slice(at + 1).trim());
			}
		else el.setAttribute(key, value === true ? "" : String(value));
	}
	for (const child of children.flat()) {
		if (child === undefined || child === null || child === false) continue;
		el.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return el;
}

// Extensions write some status lines and widgets with terminal colour codes; the window shows the text.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export const stripAnsi = (text) => String(text ?? "").replace(ANSI, "");

export function clear(el) {
	while (el.firstChild) el.firstChild.remove();
}

// Rebuilding a list under the pointer loses its hover and any click in progress, so a list that shows the same
// thing keeps its elements. `owners` are the objects its listeners act on, which comparing the elements cannot see.
export function show(el, nodes, owners = []) {
	const same =
		owners.length === el.owners?.length &&
		owners.every((owner, index) => owner === el.owners[index]) &&
		nodes.length === el.childElementCount &&
		nodes.every((node, index) => node.isEqualNode(el.children[index]));
	el.owners = owners;
	if (!same) el.replaceChildren(...nodes);
}

export async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const area = h("textarea", { class: "offscreen", "aria-hidden": "true" });
		area.value = text;
		document.body.append(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	}
}

export function formatDuration(ms) {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")}`;
}
