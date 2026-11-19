// The phone home's "Done": which conversations finished a turn while the reader was elsewhere.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Finished } from "../ui/phone/finished.js";

const view = (path, streaming) => ({ path, streaming, closed: false, lostLink: false });

test("a turn that ends while the home is shown is done, until its conversation is on screen", () => {
	const finished = new Finished();
	const a = view("a", true);
	finished.track([a], undefined, false);
	assert.equal(finished.has("a"), false, "still at work");
	a.streaming = false;
	finished.track([a], undefined, false);
	assert.equal(finished.has("a"), true);
	finished.track([a], undefined, false);
	assert.equal(finished.has("a"), true, "stays done while nobody looks");
	finished.track([a], a, false);
	assert.equal(finished.has("a"), false, "looked at");
});

test("a turn that ends in another conversation than the one on screen is done; the one on screen is not", () => {
	const finished = new Finished();
	const a = view("a", true);
	const b = view("b", true);
	finished.track([a, b], a, false);
	a.streaming = false;
	b.streaming = false;
	finished.track([a, b], a, false);
	assert.equal(finished.has("a"), false);
	assert.equal(finished.has("b"), true);
});

test("a conversation that never worked, or that works again, is not done", () => {
	const finished = new Finished();
	const a = view("a", false);
	finished.track([a], undefined, false);
	assert.equal(finished.has("a"), false);
	a.streaming = true;
	finished.track([a], undefined, false);
	a.streaming = false;
	finished.track([a], undefined, false);
	assert.equal(finished.has("a"), true);
	a.streaming = true;
	finished.track([a], undefined, false);
	assert.equal(finished.has("a"), false);
});

test("a turn cut by a lost link or a closed conversation is not a finished turn", () => {
	for (const cut of ["lost", "lostLink", "closed"]) {
		const finished = new Finished();
		const a = view("a", true);
		finished.track([a], undefined, false);
		a.streaming = false;
		if (cut !== "lost") a[cut] = true;
		finished.track([a], undefined, cut === "lost");
		assert.equal(finished.has("a"), false, cut);
	}
});

test("a conversation no longer open is forgotten", () => {
	const finished = new Finished();
	const a = view("a", true);
	finished.track([a], undefined, false);
	a.streaming = false;
	finished.track([a], undefined, false);
	finished.track([], undefined, false);
	assert.equal(finished.has("a"), false);
	assert.equal(finished.streaming.size, 0);
});
