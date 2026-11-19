// The phone's long press on Send: it queues once, and the press's own click does not send too.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

// gestures.js builds its buttons with the page's helpers; only the long press is tested here, without a page.
globalThis.document = { documentElement: { lang: "en" } };
const { HOLD, holdToQueue } = await import("../ui/phone/gestures.js");

function press() {
	const button = new EventTarget();
	let held = 0;
	holdToQueue(button, () => held++);
	const fire = (type) => {
		const event = new Event(type, { cancelable: true });
		button.dispatchEvent(event);
		return event;
	};
	return { fire, held: () => held };
}

test("a short press stays a click and queues nothing", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	const { fire, held } = press();
	fire("pointerdown");
	mock.timers.tick(HOLD - 1);
	fire("pointerup");
	mock.timers.tick(1000);
	assert.equal(held(), 0);
	assert.equal(fire("click").defaultPrevented, false, "the form is submitted as usual");
	mock.timers.reset();
});

test("a press held long enough queues once, and its click is dropped", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	const { fire, held } = press();
	fire("pointerdown");
	mock.timers.tick(HOLD);
	assert.equal(held(), 1);
	fire("pointerup");
	assert.equal(fire("click").defaultPrevented, true, "not sent a second time");
	assert.equal(fire("click").defaultPrevented, false, "the next click is a click again");
	assert.equal(held(), 1);
	mock.timers.reset();
});

test("Android's long press, reported as a context menu before the timer, counts once", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	const { fire, held } = press();
	fire("pointerdown");
	mock.timers.tick(HOLD - 50);
	assert.equal(fire("contextmenu").defaultPrevented, true, "no system menu");
	mock.timers.tick(1000);
	assert.equal(held(), 1);
	fire("contextmenu");
	assert.equal(held(), 1, "a second report of the same press adds nothing");
	mock.timers.reset();
});

test("a press that slides off the button or is taken by a scroll queues nothing", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	for (const type of ["pointerleave", "pointercancel"]) {
		const { fire, held } = press();
		fire("pointerdown");
		fire(type);
		mock.timers.tick(1000);
		assert.equal(held(), 0, type);
	}
	mock.timers.reset();
});
