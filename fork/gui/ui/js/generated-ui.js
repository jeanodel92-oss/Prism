// The window's view of a generated UI (show_ui, packages/coding-agent/src/fork/generated-ui.ts). The engine
// validates the document; the window only draws its blocks, with DOM nodes and SVG from this catalogue.
// Every string goes in as text, colours come from the theme, nothing loads from anywhere. While the model
// writes the call, the engine sends its complete blocks, validated the same way (ui_preview).
//
// A choices or form block is answered with `ui_submit`: the engine builds and sends the message from its
// own copy of the document; the window sends only which option, or the field values.

import { h } from "./dom.js";
import { t } from "./i18n.js";

const SVG = "http://www.w3.org/2000/svg";
const SERIES = 6;

const str = (value) => (typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "");
const arr = (value) => (Array.isArray(value) ? value : []);
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

function svg(tag, attrs = {}, ...children) {
	const el = document.createElementNS(SVG, tag);
	for (const [key, value] of Object.entries(attrs)) if (value !== undefined) el.setAttribute(key, String(value));
	for (const child of children) if (child) el.append(child);
	return el;
}

function format(value) {
	return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
}

/**
 * The document as DOM. `answer({choice})` / `answer({values})` sends an answer; undefined for a preview.
 * Its controls start disabled: `setAnswerable` turns them on and off without rebuilding them, so what the
 * user typed stays.
 */
export function renderDocument(document, answer) {
	const root = h("div", { class: "gen-ui" });
	if (str(document?.title)) root.append(h("div", { class: "gen-title", text: str(document.title) }));
	for (const block of arr(document?.blocks)) {
		const el = renderBlock(block, answer);
		if (!el) continue;
		const titled = str(block.title) ? h("div", { class: "gen-block-title", text: str(block.title) }) : undefined;
		root.append(h("section", { class: "gen-block", dataset: { type: block.type } }, titled, el));
	}
	setAnswerable(root, false);
	return root;
}

export function setAnswerable(root, enabled) {
	for (const control of root.querySelectorAll("button, input, select")) control.disabled = !enabled;
}

function renderBlock(block, answer) {
	switch (block?.type) {
		case "table":
			return table(block);
		case "list": {
			const items = arr(block.items).map(str).filter(Boolean);
			return items.length ? h(block.ordered ? "ol" : "ul", {}, items.map((item) => h("li", { text: item }))) : undefined;
		}
		case "facts": {
			const items = arr(block.items).filter((item) => str(item?.label));
			if (!items.length) return undefined;
			return h("dl", {}, items.flatMap((item) => [h("dt", { text: str(item.label) }), h("dd", { text: str(item.value) })]));
		}
		case "chart":
			return chart(block);
		case "choices":
			return choices(block, answer);
		case "form":
			return form(block, answer);
		default:
			return undefined;
	}
}

function table(block) {
	const columns = arr(block.columns).map(str);
	if (!columns.length) return undefined;
	const numeric = columns.map((_, i) => {
		const cells = arr(block.rows).map((row) => arr(row)[i]).filter((c) => c !== "" && c !== undefined);
		return cells.length > 0 && cells.every((c) => typeof c === "number");
	});
	const cell = (tag, value, i) =>
		h(tag, { class: numeric[i] ? "num" : undefined, text: typeof value === "number" ? format(value) : str(value) });
	return h(
		"div",
		{ class: "gen-scroll" },
		h(
			"table",
			{},
			h("thead", {}, h("tr", {}, columns.map((c, i) => cell("th", c, i)))),
			h(
				"tbody",
				{},
				arr(block.rows).map((row) => h("tr", {}, columns.map((_, i) => cell("td", arr(row)[i], i)))),
			),
		),
	);
}

/**
 * A chart's vertical scale: zero and every value fit between the top and the bottom. Differences are taken on
 * fractions of the largest magnitude, so two extreme finite values (1e308 and -1e308) do not overflow to Infinity and
 * NaN coordinates.
 */
export function chartScale(values, top, height) {
	const high = Math.max(0, ...values);
	const low = Math.min(0, ...values);
	const scale = Math.max(high, -low) || 1;
	const span = high / scale - low / scale || 1;
	return { high, low, y: (v) => top + ((high / scale - v / scale) / span) * height };
}

/** A bar or line chart drawn in SVG, scaled to its values; its numbers are also in a table (hover, copy). */
function chart(block) {
	const labels = arr(block.labels).map(str);
	const series = arr(block.series)
		.slice(0, SERIES)
		.map((s, i) => ({ name: str(s?.name) || `${i + 1}`, values: labels.map((_, j) => num(arr(s?.values)[j])) }))
		.filter((s) => s.values.some((v) => v !== undefined));
	if (!labels.length || !series.length) return undefined;
	const unit = str(block.unit);
	const all = series.flatMap((s) => s.values).filter((v) => v !== undefined);
	const width = 600;
	const height = 220;
	const pad = { left: 44, right: 8, top: 10, bottom: 34 };
	const plotW = width - pad.left - pad.right;
	const plotH = height - pad.top - pad.bottom;
	const { high: top, low: bottom, y } = chartScale(all, pad.top, plotH);
	const slot = plotW / labels.length;
	const x = (i) => pad.left + slot * (i + 0.5);
	const graph = svg("svg", {
		viewBox: `0 0 ${width} ${height}`,
		role: "img",
		"aria-label": [str(block.title), ...series.map((s) => s.name)].filter(Boolean).join(", "),
	});
	// Axis: zero, the top and the bottom values.
	for (const v of new Set([bottom, 0, top])) {
		graph.append(svg("line", { class: v === 0 ? "axis" : "grid", x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }));
		const tick = svg("text", { class: "tick", x: pad.left - 6, y: y(v) + 4, "text-anchor": "end" });
		tick.textContent = format(v);
		graph.append(tick);
	}
	const every = Math.ceil(labels.length / 12);
	labels.forEach((label, i) => {
		if (i % every) return;
		const text = svg("text", { class: "tick", x: x(i), y: height - pad.bottom + 16, "text-anchor": "middle" });
		text.textContent = label.length > 10 ? `${label.slice(0, 9)}…` : label;
		graph.append(text);
	});
	series.forEach((s, k) => {
		const value = (v, i) => `${labels[i]} · ${s.name}: ${format(v)}${unit ? ` ${unit}` : ""}`;
		if (block.kind === "line") {
			const points = s.values.map((v, i) => (v === undefined ? undefined : `${x(i)},${y(v)}`)).filter(Boolean);
			graph.append(svg("polyline", { class: `series s${k}`, points: points.join(" "), fill: "none" }));
			s.values.forEach((v, i) => {
				if (v === undefined) return;
				const dot = svg("circle", { class: `series s${k}`, cx: x(i), cy: y(v), r: 3 });
				dot.append(svg("title"));
				dot.firstChild.textContent = value(v, i);
				graph.append(dot);
			});
		} else {
			const bar = (slot * 0.8) / series.length;
			s.values.forEach((v, i) => {
				if (v === undefined) return;
				const rect = svg("rect", {
					class: `series s${k}`,
					x: x(i) - slot * 0.4 + bar * k,
					y: Math.min(y(v), y(0)),
					width: Math.max(1, bar - 1),
					height: Math.max(1, Math.abs(y(v) - y(0))),
				});
				rect.append(svg("title"));
				rect.firstChild.textContent = value(v, i);
				graph.append(rect);
			});
		}
	});
	const legend =
		series.length > 1
			? h(
					"div",
					{ class: "gen-legend" },
					series.map((s, k) => h("span", {}, h("i", { class: `swatch s${k}` }), s.name)),
				)
			: undefined;
	return h("figure", {}, graph, legend);
}

function choices(block, answer) {
	const options = arr(block.options).filter((o) => str(o?.label));
	if (!options.length) return undefined;
	return h(
		"div",
		{ class: "gen-choices" },
		options.map((option, choice) =>
			h("button", {
				type: "button",
				class: "option",
				text: str(option.label),
				onclick: () => answer?.({ choice }),
			}),
		),
	);
}

// Codex review of 2026-11-09, 327: no prototype, so a field named `__proto__` is stored as data instead of
// going through the inherited setter.
export function formValues(inputs) {
	const values = Object.create(null);
	for (const { name, field, input } of inputs)
		values[name] = field.kind === "toggle" ? input.checked : input.value;
	return values;
}

function form(block, answer) {
	const fields = arr(block.fields).filter((f) => str(f?.label));
	if (!fields.length) return undefined;
	const el = h("form", { class: "gen-form" });
	const inputs = fields.map((field) => {
		const name = str(field.name) || str(field.label);
		let input;
		if (field.kind === "toggle") input = h("input", { type: "checkbox" });
		else if (field.kind === "select")
			input = h(
				"select",
				{},
				field.required ? undefined : h("option", { value: "", text: "—" }),
				arr(field.options).map((o) => h("option", { value: str(o), text: str(o) })),
			);
		else input = h("input", { type: field.kind === "number" ? "number" : "text", step: field.kind === "number" ? "any" : undefined });
		if (field.required && field.kind !== "toggle") input.required = true;
		el.append(h("label", { class: field.kind === "toggle" ? "toggle" : undefined }, h("span", { text: str(field.label) }), input));
		return { name, field, input };
	});
	el.append(
		h("div", { class: "gen-actions" }, h("button", { type: "submit", class: "primary", text: str(block.submit) || t("send") })),
	);
	el.addEventListener("submit", (event) => {
		event.preventDefault();
		if (!answer || !el.reportValidity()) return;
		answer({ values: formValues(inputs) });
	});
	return el;
}
