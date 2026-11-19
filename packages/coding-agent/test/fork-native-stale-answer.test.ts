/**
 * fork: in the window, an answer submitted twice to a sign-in question was
 * queued, then sent again once the next question showed: the next question took the first one's answer. Each action
 * now carries the number of the question it answers, and an item id is checked against its screen's prefix.
 */
import { describe, expect, it } from "vitest";
import { NativeLoginView } from "../src/fork/login-native.ts";

const revisionOf = (view: NativeLoginView) => view.nativeMenu.revision as number;

describe("fork: native screens refuse an answer meant for an earlier question", () => {
	it("refuses a queued answer to the previous prompt", async () => {
		const view = new NativeLoginView(() => {}, "Login");
		view.begin("Sign in");
		const first = view.prompt({ type: "text", message: "First?" });
		const answer = { kind: "input", value: "one", revision: revisionOf(view) };
		expect(view.handleNativeMenuInput(answer)).toBe(true);
		await expect(first).resolves.toBe("one");

		const second = view.prompt({ type: "text", message: "Second?" });
		expect(view.handleNativeMenuInput(answer)).toBe(false);
		expect(view.handleNativeMenuInput({ kind: "input", value: "two", revision: revisionOf(view) })).toBe(true);
		await expect(second).resolves.toBe("two");
	});

	it("refuses an item of an earlier choice, whatever its prefix", async () => {
		const view = new NativeLoginView(() => {}, "Login");
		const items = [{ id: "a", label: "A" }];
		const first = view.choose("pick", "Pick", items);
		const earlier = (view.nativeMenu.items as Array<{ id: string }>)[0]!.id;
		expect(view.handleNativeMenuInput({ kind: "activate", itemId: earlier })).toBe(true);
		await expect(first).resolves.toBe("a");

		const second = view.choose("pick", "Pick", items);
		expect(view.handleNativeMenuInput({ kind: "activate", itemId: earlier })).toBe(false);
		view.close();
		await expect(second).resolves.toBeUndefined();
	});

	it("keeps the number of a screen that is only redrawn, so its Cancel still counts", () => {
		const view = new NativeLoginView(() => {}, "Login");
		const controller = view.begin("Sign in");
		const shown = revisionOf(view);
		view.notify({ type: "info", message: "Waiting" });
		expect(revisionOf(view)).toBe(shown);
		expect(view.handleNativeMenuInput({ kind: "back", revision: shown })).toBe(true);
		expect(controller.signal.aborted).toBe(true);
	});
});
