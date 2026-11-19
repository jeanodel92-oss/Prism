/**
 * the agent's desktop, live, in the terminal (/desktop). A picture every 100 ms, asked for only once the
 * previous one arrived; every 2 s while the desktop is not running; nothing more once the view is closed.
 */
import { setCapabilities, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopLiveView, IDLE_MS, LIVE_MS, type LiveFrame } from "../src/fork/desktop/live-view.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("desktop live view in the terminal", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		vi.useFakeTimers();
		setLanguage("en");
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
	});
	afterEach(() => {
		vi.useRealTimers();
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	});

	function view(source: () => Promise<LiveFrame | undefined>) {
		const closed: string[] = [];
		const renders: number[] = [];
		const component = new DesktopLiveView({
			source,
			height: () => 20,
			onClose: () => closed.push("closed"),
			requestRender: () => renders.push(Date.now()),
		});
		const text = (width = 80) => stripTerminalSequences(component.render(width).join("\n"));
		return { component, closed, renders, text };
	}

	it("shows the desktop, asks again 100 ms after a picture arrives, never while one is pending", async () => {
		const pending: Array<(frame: LiveFrame | undefined) => void> = [];
		const source = vi.fn(() => new Promise<LiveFrame | undefined>((resolve) => pending.push(resolve)));
		const { component, text } = view(source);
		expect(source).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(5000);
		// The first picture has not arrived: no second request.
		expect(source).toHaveBeenCalledTimes(1);
		pending[0]!({ data: PNG, width: 1280, height: 720 });
		await vi.advanceTimersByTimeAsync(0);
		expect(text()).toContain("The agent's own desktop · 1280×720");
		expect(component.render(80).join("\n")).toContain("\x1b_G");
		await vi.advanceTimersByTimeAsync(LIVE_MS - 1);
		expect(source).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(source).toHaveBeenCalledTimes(2);
		pending[1]!({ data: PNG, width: 1280, height: 720 });
		await vi.advanceTimersByTimeAsync(0);
		for (const width of [30, 64, 120]) {
			const lines = component.render(width);
			expect(lines).toHaveLength(20);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("says the desktop is not running and looks again every 2 s, then shows it once it runs", async () => {
		let running = false;
		const source = vi.fn(async () => (running ? { data: PNG, width: 1280, height: 720 } : undefined));
		const { text } = view(source);
		await vi.advanceTimersByTimeAsync(0);
		expect(text()).toContain("The agent's desktop is not running. The agent starts it when it needs it.");
		await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
		expect(source).toHaveBeenCalledTimes(1);
		running = true;
		await vi.advanceTimersByTimeAsync(1);
		expect(source).toHaveBeenCalledTimes(2);
		expect(text()).toContain("1280×720");
	});

	it("reports a failed capture and keeps looking", async () => {
		const source = vi
			.fn<() => Promise<LiveFrame | undefined>>()
			.mockRejectedValueOnce(new Error("the desktop helper stopped"))
			.mockResolvedValue({ data: PNG, width: 1280, height: 720 });
		const { text } = view(source);
		await vi.advanceTimersByTimeAsync(0);
		expect(text()).toContain("Could not capture the desktop: the desktop helper stopped");
		await vi.advanceTimersByTimeAsync(IDLE_MS);
		expect(text()).toContain("1280×720");
	});

	it("Esc closes it, and it asks for nothing more", async () => {
		const source = vi.fn(async () => ({ data: PNG, width: 1280, height: 720 }));
		const { component, closed } = view(source);
		await vi.advanceTimersByTimeAsync(0);
		component.handleInput("\x1b");
		expect(closed).toEqual(["closed"]);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(source).toHaveBeenCalledTimes(1);
	});

	it("speaks French", async () => {
		setLanguage("fr");
		const { text } = view(async () => undefined);
		await vi.advanceTimersByTimeAsync(0);
		expect(text()).toContain("Le bureau de l’agent n’est pas lancé.");
		expect(text()).toContain("échap fermer · /desktop stop arrête le bureau");
		setLanguage("en");
	});
});
