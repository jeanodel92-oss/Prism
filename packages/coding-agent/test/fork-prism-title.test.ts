import { afterEach, describe, expect, it, vi } from "vitest";
import { createState } from "../src/fork/prism/lib/state.ts";
import { createTitleSpinner } from "../src/fork/prism/title.ts";

describe("fork: Prism terminal title animations", () => {
	afterEach(() => vi.useRealTimers());

	it("keeps the title still while working when animations are off", () => {
		vi.useFakeTimers();
		const state = createState();
		state.animates = () => false;
		const setTitle = vi.fn();
		const terminal = { setTitle };
		const spinner = createTitleSpinner(state);
		spinner.attach({ terminal });
		terminal.setTitle("Remote session");
		spinner.start();
		vi.advanceTimersByTime(1000);
		expect(setTitle.mock.calls).toEqual([["Remote session"]]);
		expect(vi.getTimerCount()).toBe(0);
		terminal.setTitle("Renamed session");
		vi.advanceTimersByTime(1000);
		spinner.stop();
		expect(setTitle.mock.calls).toEqual([["Remote session"], ["Renamed session"]]);
	});

	it("animates when enabled and restores the latest title when work settles", () => {
		vi.useFakeTimers();
		const state = createState();
		state.animates = () => true;
		const setTitle = vi.fn();
		const terminal = { setTitle };
		const spinner = createTitleSpinner(state);
		spinner.attach({ terminal });
		terminal.setTitle("Remote session");
		spinner.start();
		spinner.start();
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(160);
		expect(setTitle).toHaveBeenLastCalledWith("◐ Remote session");
		terminal.setTitle("Renamed session");
		vi.advanceTimersByTime(160);
		expect(setTitle).toHaveBeenLastCalledWith("◓ Renamed session");
		spinner.stop();
		expect(setTitle).toHaveBeenLastCalledWith("Renamed session");
		expect(vi.getTimerCount()).toBe(0);
	});
});
