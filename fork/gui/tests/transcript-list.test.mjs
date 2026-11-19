// fork: the window draws only the transcript's entries around the view (transcript-list.js). The
// arithmetic that picks them, on heights alone. Run by hand: node --test fork/gui/tests/transcript-list.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

const { endRange, firstFrom, rangeOf, topsOf } = await import("../ui/js/transcript-list.js");

// Five entries of 100 px and a gap of 10: tops 0, 110, 220, 330, 440; the last gap ends at 550.
const tops = topsOf([110, 110, 110, 110, 110]);

test("tops add each entry's height and gap", () => {
	assert.deepEqual([...tops], [0, 110, 220, 330, 440, 550]);
	assert.deepEqual([...topsOf([])], [0]);
});

test("an entry that takes no room (a turn's slot) moves nothing", () => {
	assert.deepEqual([...topsOf([110, 0, 110])], [0, 110, 110, 220]);
});

test("the first entry crossing a line, or after it", () => {
	assert.equal(firstFrom(tops, -50), 0);
	assert.equal(firstFrom(tops, 0), 0);
	assert.equal(firstFrom(tops, 109), 0);
	assert.equal(firstFrom(tops, 110), 1);
	assert.equal(firstFrom(tops, 300), 2);
	assert.equal(firstFrom(tops, 10_000), 5);
});

test("the entries crossing a band of the transcript", () => {
	assert.deepEqual(rangeOf(tops, 0, 50), [0, 0]);
	assert.deepEqual(rangeOf(tops, 115, 225), [1, 2]);
	assert.deepEqual(rangeOf(tops, 115, 219), [1, 1]);
	assert.deepEqual(rangeOf(tops, -600, 10_000), [0, 4]);
	// Beyond the end (a view put below the last entry): the last one, never an empty range.
	assert.deepEqual(rangeOf(tops, 9_000, 10_000), [4, 4]);
	assert.deepEqual(rangeOf(topsOf([]), 0, 100), [0, -1]);
});

test("the end: the last entries that fill the room", () => {
	assert.deepEqual(endRange(tops, 100), [4, 4]);
	assert.deepEqual(endRange(tops, 111), [3, 4]);
	assert.deepEqual(endRange(tops, 10_000), [0, 4]);
	assert.deepEqual(endRange(topsOf([]), 100), [0, -1]);
});

test("20,000 entries: a view of 800 px draws a handful", () => {
	const many = topsOf(new Array(20_000).fill(250));
	const [first, last] = rangeOf(many, 2_500_000 - 800, 2_500_000 + 1600);
	assert.ok(last - first + 1 <= 12, `${last - first + 1} entries`);
	const [endFirst, endLast] = endRange(many, 1600);
	assert.equal(endLast, 19_999);
	assert.ok(endLast - endFirst + 1 <= 8);
});
