import assert from "node:assert/strict";
import { test } from "node:test";
import { chartScale, formValues } from "../ui/js/generated-ui.js";

// review of 2026-11-09, 327: a field named like an Object member keeps its answer in the payload.
test("form answers keep fields named like Object members", () => {
	const inputs = ["__proto__", "constructor", "toString"].map((name, index) => ({
		name,
		field: { kind: index === 1 ? "toggle" : "text" },
		input: { value: `v-${name}`, checked: true },
	}));
	const values = formValues(inputs);
	assert.deepEqual(JSON.parse(JSON.stringify(values)), JSON.parse('{"__proto__":"v-__proto__","constructor":true,"toString":"v-toString"}'));
});

// extreme finite values keep finite, ordered coordinates.
test("a chart of extreme finite values keeps every coordinate finite", () => {
	const values = [1e308, -1e308, 0, 5];
	const { y } = chartScale(values, 10, 176);
	const ys = values.map(y);
	for (const v of ys) assert.ok(Number.isFinite(v), `y = ${v}`);
	assert.equal(ys[0], 10);
	assert.equal(ys[1], 186);
	// Zero in the middle; 5 is on it at this scale (a fraction of 1e308 below a pixel).
	assert.equal(ys[2], 98);
	assert.ok(ys[3] <= ys[2]);
	// Usual values: as before.
	const usual = chartScale([2, -2], 10, 100);
	assert.deepEqual([usual.y(2), usual.y(0), usual.y(-2)], [10, 60, 110]);
	assert.equal(chartScale([0, 0], 10, 100).y(0), 10);
});
