// The phone's notices: which changes of the conversations Android is told about, and when.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Notices, noticeId } from "../ui/phone/notices.js";

const view = (path, streaming = false) => ({ path, title: `title of ${path}`, streaming, dialogs: new Map(), closed: false, lostLink: false });

function bench() {
	const posted = [];
	const cleared = [];
	const notices = new Notices(
		(notice) => posted.push(`${notice.kind}:${notice.title}:${notice.id}`),
		(ids) => cleared.push(ids),
	);
	return { notices, posted, cleared };
}

test("a turn that ends while the app is in the background is told, once", () => {
	const { notices, posted } = bench();
	const a = view("a", true);
	notices.track([a], true, false);
	assert.deepEqual(posted, [], "still at work");
	a.streaming = false;
	notices.track([a], true, false);
	assert.deepEqual(posted, [`done:title of a:${noticeId("a")}`]);
	notices.track([a], true, false);
	assert.equal(posted.length, 1, "not told again");
});

test("nothing is told while the app is on screen", () => {
	const { notices, posted, cleared } = bench();
	const a = view("a", true);
	notices.track([a], false, false);
	a.dialogs.set("q", {});
	notices.track([a], false, false);
	a.dialogs.clear();
	a.streaming = false;
	notices.track([a], false, false);
	assert.deepEqual(posted, []);
	assert.deepEqual(cleared, [], "nothing to take away");
});

test("a question asked in the background is told; the end of the turn it stops is not told as done", () => {
	const { notices, posted } = bench();
	const a = view("a", true);
	notices.track([a], true, false);
	a.dialogs.set("q", {});
	notices.track([a], true, false);
	assert.deepEqual(posted, [`waiting:title of a:${noticeId("a")}`]);
	a.streaming = false;
	notices.track([a], true, false);
	assert.equal(posted.length, 1, "still waiting: not done");
});

test("a question shown again after a reconnection is not a new one; a later question is", () => {
	const { notices, posted } = bench();
	const a = view("a", true);
	notices.track([a], true, false);
	a.dialogs.set("q", {});
	notices.track([a], true, false);
	// The link drops, the page forgets the question, the PC shows it again.
	a.lostLink = true;
	a.dialogs.clear();
	notices.track([a], true, true);
	a.lostLink = false;
	notices.track([a], true, false);
	a.dialogs.set("q", {});
	notices.track([a], true, false);
	assert.equal(posted.length, 1, "the same question");
	// Answered on the PC's screen, then another one.
	a.dialogs.clear();
	notices.track([a], true, false);
	notices.track([a], true, false);
	a.dialogs.set("q2", {});
	notices.track([a], true, false);
	assert.equal(posted.length, 2);
});

test("a turn cut by a lost link or a closed conversation is not told as done", () => {
	const { notices, posted } = bench();
	const a = view("a", true);
	const b = view("b", true);
	notices.track([a, b], true, false);
	a.streaming = false;
	notices.track([a, b], true, true);
	b.streaming = false;
	b.closed = true;
	notices.track([a, b], true, false);
	assert.deepEqual(posted, [`done:title of a:${noticeId("a")}`], "a's turn had ended on the PC: told once the link is back; b was closed");
});

test("a conversation seen for the first time already waiting or idle tells nothing", () => {
	const { notices, posted } = bench();
	const a = view("a");
	a.dialogs.set("q", {});
	notices.track([a, view("b")], true, false);
	assert.deepEqual(posted, []);
});

test("back on screen, the app takes its own notices away, and only those", () => {
	const { notices, posted, cleared } = bench();
	const a = view("a", true);
	const b = view("b", true);
	notices.track([a, b], true, false);
	a.streaming = false;
	notices.track([a, b], true, false);
	notices.track([a, b], false, false);
	assert.equal(posted.length, 1);
	assert.deepEqual(cleared, [[noticeId("a")]]);
	notices.track([a, b], false, false);
	assert.equal(cleared.length, 1, "once");
});

test("a notice's number is a positive 32-bit integer, stable for a conversation and distinct between two", () => {
	const id = noticeId("/home/u/.prism/sessions/a.jsonl");
	assert.equal(id, noticeId("/home/u/.prism/sessions/a.jsonl"));
	assert.notEqual(id, noticeId("/home/u/.prism/sessions/b.jsonl"));
	assert.ok(Number.isInteger(id) && id >= 0 && id <= 0x7fffffff);
});
