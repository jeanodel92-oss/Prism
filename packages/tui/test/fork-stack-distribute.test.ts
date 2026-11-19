// fork: a stack shared its free or missing space with a remainder that
// shrank inside a pass, so the first of two equal children got 7 of 10 cells and the second 3.
import assert from "node:assert";
import { describe, it } from "node:test";
import { allocateStackSizes } from "../src/components/stack.ts";
import type { StackLayoutEntry } from "../src/layout-node.ts";

const component = { render: () => [], invalidate: () => {} };
const entry = (options: Partial<StackLayoutEntry>): StackLayoutEntry => ({ component, ...options });

describe("fork: stack space shared by weight", () => {
	it("gives equal growing children equal sizes", () => {
		assert.deepStrictEqual(allocateStackSizes([entry({ grow: 1 }), entry({ grow: 1 })], [0, 0], 10, 0), [5, 5]);
		assert.deepStrictEqual(
			allocateStackSizes([entry({ grow: 1 }), entry({ grow: 1 }), entry({ grow: 1 })], [0, 0, 0], 30, 0),
			[10, 10, 10],
		);
		assert.deepStrictEqual(allocateStackSizes([entry({ grow: 1 }), entry({ grow: 3 })], [0, 0], 20, 0), [5, 15]);
	});

	it("shrinks equal children equally", () => {
		assert.deepStrictEqual(allocateStackSizes([entry({}), entry({})], [10, 10], 10, 0), [5, 5]);
	});

	it("gives the same sizes whatever the children's order", () => {
		const a = entry({ grow: 1, maxSize: 4 });
		const b = entry({ grow: 2 });
		const c = entry({ grow: 1 });
		const forward = allocateStackSizes([a, b, c], [1, 0, 2], 25, 0);
		const backward = allocateStackSizes([c, b, a], [2, 0, 1], 25, 0);
		assert.deepStrictEqual(backward, [...forward].reverse());
		assert.strictEqual(
			forward.reduce((sum, size) => sum + size, 0),
			25,
		);
		assert.strictEqual(forward[0], 4);
	});

	it("still fills every cell when the space does not divide evenly", () => {
		const sizes = allocateStackSizes([entry({ grow: 1 }), entry({ grow: 1 }), entry({ grow: 1 })], [0, 0, 0], 4, 0);
		assert.strictEqual(
			sizes.reduce((sum, size) => sum + size, 0),
			4,
		);
		assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
	});
});
