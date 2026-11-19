// The phone home's mosaic: the cells and the slabs' planes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as facets from "../ui/phone/facets.js";
import { chord, fitLabel, layout, nearest, outline, slab } from "../ui/phone/facets.js";

const ASPECT = 915 / 412;
const TOP = 54 / 412;
const weights = (count) => Array.from({ length: count }, (_, k) => (k === count - 1 ? 0.25 : 1 - k / 8));

test("no item, no site", () => {
	assert.deepEqual(layout(0, ASPECT, [], TOP), []);
});

test("one site per item, from 1 to 8, each with its centre of gravity in the area under the header", () => {
	for (let count = 1; count <= 8; count++) {
		const sites = layout(count, ASPECT, weights(count), TOP);
		assert.equal(sites.length, count);
		for (const site of sites) {
			assert.ok(site.cx > 0 && site.cx < 1, `cx ${site.cx}`);
			assert.ok(site.cy > TOP && site.cy < ASPECT, `cy ${site.cy}`);
		}
	}
});

test("a touch on a cell's centre of gravity picks that cell", () => {
	const sites = layout(8, ASPECT, weights(8), TOP);
	sites.forEach((site, k) => assert.equal(nearest(sites, site.cx, site.cy), k));
});

test("each slab has 1 to 80 planes, holds its centre of gravity and stays in the area", () => {
	for (let count = 1; count <= 8; count++) {
		const sites = layout(count, ASPECT, weights(count), TOP);
		sites.forEach((site, k) => {
			const { planes, poly } = slab(sites, k, ASPECT, TOP);
			assert.ok(planes.length >= 1 && planes.length <= 80, `${planes.length} planes`);
			for (const plane of planes) {
				assert.ok(Math.abs(Math.hypot(plane[0], plane[1], plane[2]) - 1) < 1e-9, "unit normal");
			}
			// The centre of gravity, on the slab's middle plane (z = 0), is inside every plane.
			const p = [site.cx - site.x, site.cy - site.y, 0];
			for (const plane of planes) assert.ok(plane[0] * p[0] + plane[1] * p[1] + plane[2] * p[2] < plane[3], `count ${count} slab ${k}: centre outside`);
			for (const [x, y] of poly) {
				assert.ok(x > 0 && x < 1, `x ${x}`);
				assert.ok(y > TOP && y < ASPECT, `y ${y}`);
			}
		});
	}
});

test("two neighbouring slabs keep a seam between them", () => {
	const sites = layout(8, ASPECT, weights(8), TOP);
	const polys = sites.map((_, k) => outline(sites, k, ASPECT, TOP));
	const inside = (poly, x, y) => {
		let sign = 0;
		for (let i = 0; i < poly.length; i++) {
			const [ax, ay] = poly[i];
			const [bx, by] = poly[(i + 1) % poly.length];
			const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
			if (Math.abs(cross) < 1e-12) continue;
			if (sign === 0) sign = Math.sign(cross);
			else if (Math.sign(cross) !== sign) return false;
		}
		return true;
	};
	polys.forEach((poly, k) => {
		for (const [x, y] of poly) {
			polys.forEach((other, j) => {
				if (j !== k) assert.ok(!inside(other, x, y), `corner of ${k} inside ${j}`);
			});
		}
	});
});

test("a title stays inside its slab, clear of the bevel, and narrows where the slab is narrow", () => {
	const sites = layout(8, ASPECT, weights(8), TOP);
	const inset = 0.04;
	sites.forEach((site, k) => {
		const poly = outline(sites, k, ASPECT, TOP);
		// A wide title (two thirds of the screen), 40 px high at 412 px.
		const height = 40 / 412;
		const fit = fitLabel(poly, site.cx, site.cy, 0.66, height, inset);
		for (const y of [site.cy - height / 2, site.cy, site.cy + height / 2]) {
			const span = chord(poly, y);
			if (!span) continue;
			assert.ok(fit.x - fit.width / 2 >= span[0] + inset - 1e-9, `slab ${k}: past the left edge`);
			assert.ok(fit.x + fit.width / 2 <= span[1] - inset + 1e-9, `slab ${k}: past the right edge`);
		}
	});
});

test("a short title keeps its width and its place at the centre of gravity", () => {
	const sites = layout(3, ASPECT, weights(3), TOP);
	const poly = outline(sites, 0, ASPECT, TOP);
	const fit = fitLabel(poly, sites[0].cx, sites[0].cy, 0.1, 0.05, 0.04);
	assert.equal(fit.width, 0.1);
	assert.equal(fit.x, sites[0].cx);
});

test("the chord of a square", () => {
	assert.deepEqual(chord([[0, 0], [1, 0], [1, 1], [0, 1]], 0.5), [0, 1]);
	assert.equal(chord([[0, 0], [1, 0], [1, 1], [0, 1]], 2), undefined);
});

// The owner's QA of the fork.11 candidate: the band of light that swept the glass was too much; it is
// gone, with its uniforms. Only a slab at work moves (its light breathes).
test("no band of light sweeps the glass", () => {
	const source = readFileSync(new URL("../ui/phone/facets.js", import.meta.url), "utf8");
	assert.equal(facets.drift, undefined);
	for (const name of ["SHEEN", "uniform vec4 SW", "outGeo"]) assert.ok(!source.includes(name), name);
});
